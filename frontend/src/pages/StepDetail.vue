<script setup lang="ts">
/**
 * /pieces/:id/steps 吹制工序逐道记录
 * 拖拽排序并回填温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 * 消费模型：Step、Piece、GlassBatch、Furnace；复用组件：<StageTag>、<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useStepProgress } from '@/hooks/useStepProgress'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { useDrawStore } from '@/stores/drawStore'
import { STEP_NAME_OPTIONS, STEP_STATE_OPTIONS, type Step, type StepDraft, type StepName, type StepState } from '@/types/step'
import type { Draw } from '@/types/draw'
import { buildStepCardText, copyText } from '@/utils/export'
import { CRAFT_TEMP_RANGE, checkStepTemp, formatHours, totalAnnealHours } from '@/utils/thermal'

const route = useRoute()
const router = useRouter()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()
const drawStore = useDrawStore()

const pieceId = computed<string>(() => String(route.params.id ?? ''))
const piece = computed(() => pieceStore.pieces.find((row) => row.id === pieceId.value) ?? null)
const { progress } = useStepProgress(pieceId)

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const draggingId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<StepDraft>({
  pieceId: '',
  seq: 1,
  name: '取料',
  tempC: 1150,
  durationMin: 5,
  operator: '',
  remark: '',
  state: '未开始',
})

const rules: FormRules<StepDraft> = {
  seq: [{ required: true, message: '请填写工序序号', trigger: 'blur' }],
  name: [{ required: true, message: '请选择工序名称', trigger: 'change' }],
  tempC: [{ required: true, message: '请填写工序温度', trigger: 'blur' }],
  durationMin: [{ required: true, message: '请填写时长', trigger: 'blur' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
  state: [{ required: true, message: '请选择工序状态', trigger: 'change' }],
}

const steps = computed<Step[]>(() => pieceStore.stepsOf(pieceId.value))

const batch = computed(() =>
  piece.value === null ? undefined : furnaceStore.batches.find((row) => row.id === piece.value?.batchId)
)
const furnace = computed(() =>
  batch.value === undefined ? undefined : furnaceStore.furnaces.find((row) => row.id === batch.value?.furnaceId)
)

const tempCheck = computed(() =>
  piece.value === null
    ? { ok: true, message: '' }
    : checkStepTemp(form.tempC, furnace.value?.maxTempC ?? 1250, piece.value.craft)
)

const currentStep = computed<Step | null>(() => steps.value.find((row) => row.state !== '已完成') ?? null)

/* ---------------- 技师那本账：取料道次 ---------------- */

const drawDialog = ref(false)
const drawSubmitting = ref(false)
/** 0 = 首次登记；>0 = 重试对应取料道次 */
const editingDrawId = ref<string | null>(null)
/** 本道次关联的取料工序（可空） */
const drawStep = ref<Step | null>(null)
const drawFormRef = ref<FormInstance>()

const drawForm = reactive({
  seq: 1,
  stepId: '',
  batchId: '',
  drawKg: 5,
  operator: '',
})

const drawRules: FormRules<typeof drawForm> = {
  seq: [{ required: true, message: '请填写取料道次', trigger: 'blur' }],
  batchId: [{ required: true, message: '请选择料液批次', trigger: 'change' }],
  drawKg: [{ required: true, message: '请填写取料量', trigger: 'blur' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
}

const pieceDraws = computed<Draw[]>(() => drawStore.drawsOfPiece(pieceId.value))
const rejectedDraws = computed<Draw[]>(() => pieceDraws.value.filter((row) => row.state === '已退回'))
const postedDrawKg = computed<number>(() =>
  Math.round(pieceDraws.value.filter((row) => row.state === '已落账').reduce((acc, row) => acc + row.drawKg, 0) * 100) / 100,
)

/** 取料工序 → 取料道次（优先按 stepId 关联，迁移数据再按 seq 兜底） */
function drawOfStep(step: Step): Draw | undefined {
  return pieceDraws.value.find((row) => row.stepId === step.id) ?? pieceDraws.value.find((row) => row.seq === step.seq)
}

const drawBatchOptions = computed(() =>
  furnaceStore.batches
    .slice()
    .sort((a, b) => b.meltDate.localeCompare(a.meltDate))
    .map((row) => ({
      id: row.id,
      label: `${row.colorCode} · 第${row.cycle}轮 · 余 ${row.remainKg} kg（${furnaceStore.furnaces.find((f) => f.id === row.furnaceId)?.code ?? '未知窑'}）`,
    })),
)

const selectedBatchRemain = computed<number>(() => {
  const batch = furnaceStore.batches.find((row) => row.id === drawForm.batchId)
  return batch?.remainKg ?? 0
})

onMounted(() => {
  void furnaceStore.loadAll()
  void pieceStore.loadAll()
  void drawStore.loadAll()
})

/** 首次登记取料道次（可从某道「取料」工序进入） */
function openCreateDraw(step: Step | null): void {
  if (piece.value === null) return
  editingDrawId.value = null
  drawStep.value = step
  const usedSeqs = new Set(pieceDraws.value.map((row) => row.seq))
  let nextSeq = step?.seq ?? drawStore.nextSeqOfPiece(pieceId.value)
  // 道次冲突时顺延到下一个空号
  while (usedSeqs.has(nextSeq)) nextSeq += 1
  Object.assign(drawForm, {
    seq: nextSeq,
    stepId: step?.id ?? '',
    batchId: piece.value.batchId || furnaceStore.batches[0]?.id || '',
    drawKg: 5,
    operator: step?.operator || piece.value.artist || '',
  })
  drawDialog.value = true
}

/** 重试退回的取料道次（只重试技师这一条，可改批次/用量/操作人） */
function openRetryDraw(row: Draw): void {
  editingDrawId.value = row.id
  drawStep.value = steps.value.find((step) => step.id === row.stepId) ?? null
  Object.assign(drawForm, {
    seq: row.seq,
    stepId: row.stepId,
    batchId: row.batchId && furnaceStore.batches.some((b) => b.id === row.batchId) ? row.batchId : piece.value?.batchId || '',
    drawKg: row.drawKg,
    operator: row.operator,
  })
  drawDialog.value = true
}

async function submitDraw(): Promise<void> {
  if (drawFormRef.value === undefined || piece.value === null) return
  const valid = await drawFormRef.value.validate().catch(() => false)
  if (!valid) return
  // 道次唯一性（重试自身除外）
  const dup = pieceDraws.value.find((row) => row.seq === drawForm.seq && row.id !== editingDrawId.value)
  if (dup !== undefined) {
    ElMessage.warning(`第 ${drawForm.seq} 取料道次已记账（${dup.state} ${dup.drawKg} kg），一道次只记一条`)
    return
  }
  drawSubmitting.value = true
  try {
    if (editingDrawId.value === null) {
      const result = await drawStore.submitDraw({
        pieceId: pieceId.value,
        seq: drawForm.seq,
        stepId: drawForm.stepId,
        batchId: drawForm.batchId,
        drawKg: drawForm.drawKg,
        operator: drawForm.operator,
      })
      if (result.ok) {
        ElMessage.success(result.message)
        drawDialog.value = false
      } else {
        ElMessage.error(result.message)
        drawDialog.value = false
      }
    } else {
      const result = await drawStore.retryDraw(editingDrawId.value, {
        stepId: drawForm.stepId,
        batchId: drawForm.batchId,
        drawKg: drawForm.drawKg,
        operator: drawForm.operator,
      })
      if (result.ok) {
        ElMessage.success(result.message)
        drawDialog.value = false
      } else {
        ElMessage.error(result.message)
        drawDialog.value = false
      }
    }
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '取料道次保存失败')
  } finally {
    drawSubmitting.value = false
  }
}

async function quickRetryDraw(row: Draw): Promise<void> {
  try {
    const result = await drawStore.retryDraw(row.id)
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '取料道次重试失败')
  }
}

async function discardDraw(row: Draw): Promise<void> {
  try {
    await ElMessageBox.confirm(`撤销第 ${row.seq} 道退回的取料记录？批次侧从未被扣减，无需补偿。`, '撤销退回记录', {
      type: 'warning',
      confirmButtonText: '撤销',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await drawStore.discardRejected(row.id)
  ElMessage.success('已撤销该退回记录')
}


function openCreate(): void {
  editingId.value = null
  const nextSeq = steps.value.length + 1
  Object.assign(form, {
    pieceId: pieceId.value,
    seq: nextSeq,
    name: (STEP_NAME_OPTIONS[Math.min(nextSeq - 1, STEP_NAME_OPTIONS.length - 1)] ?? '取料') as StepName,
    tempC: currentStep.value?.tempC ?? 1150,
    durationMin: 5,
    operator: currentStep.value?.operator ?? '',
    remark: '',
    state: '未开始' as StepState,
  })
  dialogVisible.value = true
}

function openEdit(row: Step): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    seq: row.seq,
    name: row.name,
    tempC: row.tempC,
    durationMin: row.durationMin,
    operator: row.operator,
    remark: row.remark,
    state: row.state,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (!tempCheck.value.ok) {
    ElMessage.warning(tempCheck.value.message)
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      await pieceStore.createStep({ ...form })
      ElMessage.success(`已新增第 ${form.seq} 道「${form.name}」`)
    } else {
      await pieceStore.updateStep(editingId.value, { ...form })
      ElMessage.success('工序已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Step): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除第 ${row.seq} 道「${row.name}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await pieceStore.deleteStep(row.id)
  ElMessage.success('工序已删除')
}

async function handleAdvance(row: Step): Promise<void> {
  await pieceStore.advanceStep(row.id)
  ElMessage.success(pieceStore.lastMessage)
}

async function handleDrop(targetId: string): Promise<void> {
  const fromId = draggingId.value
  draggingId.value = null
  dragOverId.value = null
  if (fromId === null || fromId === targetId) return
  await pieceStore.moveStepBefore(pieceId.value, fromId, targetId)
  ElMessage.success(pieceStore.lastMessage)
}

async function handleCopyCard(): Promise<void> {
  if (piece.value === null) return
  const text = buildStepCardText(piece.value, batch.value, furnace.value, steps.value, [])
  const ok = await copyText(text)
  ElMessage[ok ? 'success' : 'warning'](ok ? '工序卡片已复制到剪贴板' : '当前浏览器不支持剪贴板写入')
}

function goAnnealing(): void {
  if (piece.value === null) return
  if (!progress.value.allDone) {
    ElMessage.warning(`无法进入退火排位：${progress.value.blockReason}`)
    return
  }
  pieceStore.selectPiece(piece.value.id)
  void router.push('/annealing')
}
</script>

<template>
  <div>
    <el-page-header
      :content="piece === null ? '吹制工序' : `${piece.name} · ${piece.craft} · ${piece.artist}`"
      @back="router.push('/pieces')"
    >
      <template #extra>
        <el-space wrap>
          <StageTag v-if="piece" :stage="piece.state" :craft="piece.craft" />
          <el-tag v-if="furnace" type="info">{{ furnace.code }} · 上限 {{ furnace.maxTempC }} ℃</el-tag>
          <el-tag v-if="batch" type="success">{{ batch.colorCode }} · 余 {{ batch.remainKg }} kg</el-tag>
          <el-tag v-if="piece" type="warning">理论退火 {{ formatHours(totalAnnealHours(piece.wallThicknessMm)) }}</el-tag>
        </el-space>
      </template>
    </el-page-header>

    <EmptyPanel
      v-if="pieceStore.ready && piece === null"
      title="作品不存在或已被删除"
      :description="`未能找到 id 为「${pieceId}」的作品。可能是链接已过期，或该作品已被删除。`"
      action-text="返回作品列表"
      class="mt-14"
      @action="router.push('/pieces')"
    >
      <template #extra>
        <el-button @click="router.push('/pieces')">返回</el-button>
      </template>
    </EmptyPanel>

    <template v-else>
      <div class="stat-row">
        <StatBadge label="工序总数" :value="progress.total" suffix="道" tone="primary" icon="Histogram" />
        <StatBadge label="已完成" :value="progress.done" suffix="道" tone="success" icon="DataLine" />
        <StatBadge label="进行中" :value="progress.inProgress" suffix="道" tone="warning" icon="TrendCharts" />
        <StatBadge label="未开始" :value="progress.pending" suffix="道" tone="default" icon="DataLine" />
        <StatBadge label="完成度" :value="`${progress.pct}%`" :percent="progress.pct" tone="primary" icon="PieChart" />
        <StatBadge label="累计工时" :value="progress.totalMinutes" suffix="分钟" tone="info" icon="TrendCharts" />
        <StatBadge
          label="当前道次"
          :value="progress.total === 0 ? '—' : `第 ${progress.currentSeq} 道`"
          :suffix="progress.total === 0 ? '' : progress.currentName"
          tone="warning"
          icon="Histogram"
        />
      </div>

      <el-alert
        v-if="!progress.allDone"
        type="warning"
        show-icon
        :closable="false"
        class="mb-14"
        :title="`前序工序未完成，暂不能进入退火排位：${progress.blockReason}`"
        description="必须按序号依次把每一道工序推进到「已完成」，才允许分配退火窑位与曲线段。"
      />
      <el-alert
        v-else
        type="success"
        show-icon
        :closable="false"
        class="mb-14"
        title="全部工序已完成，可以进入退火排位"
        :description="`理论退火时长 ${formatHours(totalAnnealHours(piece?.wallThicknessMm ?? 4))}（升温 / 保温 / 缓冷三段合计）。`"
      />

      <el-card shadow="never">
        <template #header>
          <div class="card-header">
            <span class="card-header__title">吹制工序逐道记录</span>
            <el-space wrap>
              <el-button @click="handleCopyCard">
                <el-icon><DocumentCopy /></el-icon>
                <span>复制工序卡片</span>
              </el-button>
              <el-button type="primary" plain @click="goAnnealing">
                <el-icon><Right /></el-icon>
                <span>进入退火排位</span>
              </el-button>
              <el-button type="primary" @click="openCreate">
                <el-icon><Plus /></el-icon>
                <span>新增工序</span>
              </el-button>
            </el-space>
          </div>
        </template>

        <EmptyPanel
          v-if="steps.length === 0"
          title="该作品还没有吹制工序"
          description="按取料 → 吹制 → 塑形 → 开模 → 收口逐道登记温度、时长与操作人；列表支持拖拽调整先后顺序。"
          action-text="登记第一道工序"
          @action="openCreate"
        />

        <ul v-else class="step-list">
          <li
            v-for="(row, index) in steps"
            :key="row.id"
            class="step-item"
            :class="{ 'is-drag-over': dragOverId === row.id, 'is-current': currentStep?.id === row.id }"
            draggable="true"
            @dragstart="draggingId = row.id"
            @dragover.prevent="dragOverId = row.id"
            @dragleave="dragOverId = null"
            @drop.prevent="handleDrop(row.id)"
          >
            <span class="step-seq">{{ index + 1 }}</span>
            <span class="step-grip" title="按住拖拽调整工序顺序">⠿</span>
            <div class="step-main">
              <div class="step-title">
                <b>{{ row.name }}</b>
                <el-tag
                  size="small"
                  :type="row.state === '已完成' ? 'success' : row.state === '进行中' ? 'warning' : 'info'"
                >
                  {{ row.state }}
                </el-tag>
                <el-tag v-if="currentStep?.id === row.id" size="small" type="danger" effect="dark">当前道次</el-tag>
                <el-tag
                  v-if="row.name === '取料' && drawOfStep(row)"
                  size="small"
                  :type="drawOfStep(row)?.state === '已落账' ? 'success' : 'danger'"
                  effect="plain"
                >
                  取料账：{{ drawOfStep(row)?.batchColorCode }} · {{ drawOfStep(row)?.drawKg }} kg ·
                  {{ drawOfStep(row)?.state === '已落账' ? '已落账' : `已退回·${drawOfStep(row)?.rejectReason}` }}
                </el-tag>
              </div>
              <div class="step-sub">
                {{ row.tempC }} ℃ · {{ row.durationMin }} 分钟 · 操作人 {{ row.operator }}
                <span v-if="row.remark !== ''"> · {{ row.remark }}</span>
              </div>
            </div>
            <div class="step-actions">
              <el-button
                v-if="row.name === '取料' && !drawOfStep(row)"
                size="small"
                type="success"
                plain
                @click="openCreateDraw(row)"
              >
                记取料道次
              </el-button>
              <el-button
                v-else-if="row.name === '取料' && drawOfStep(row)?.state === '已退回'"
                size="small"
                type="danger"
                plain
                @click="openRetryDraw(drawOfStep(row)!)"
              >
                本侧重试
              </el-button>
              <el-button
                size="small"
                type="primary"
                plain
                :disabled="row.state === '已完成'"
                @click="handleAdvance(row)"
              >
                推进状态
              </el-button>
              <el-button size="small" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="handleDelete(row)">删除</el-button>
            </div>
          </li>
        </ul>
      </el-card>

      <!-- 技师账：本作品取料道次 -->
      <el-card shadow="never" class="mt-14 draw-card">
        <template #header>
          <div class="card-header">
            <span class="card-header__title">技师取料账 · 取料道次（哪批料 / 取多少 / 操作人）</span>
            <el-space wrap>
              <el-tag type="success" effect="plain">已落账取料合计 {{ postedDrawKg }} kg</el-tag>
              <el-tag v-if="rejectedDraws.length > 0" type="danger" effect="dark">{{ rejectedDraws.length }} 道已退回</el-tag>
              <el-button type="primary" @click="openCreateDraw(null)">
                <el-icon><Plus /></el-icon>
                <span>记取料道次</span>
              </el-button>
            </el-space>
          </div>
        </template>

        <el-alert
          type="info"
          show-icon
          :closable="false"
          class="mb-14"
          title="保存时按批次当时余量扣减；两个终端同时取一批料，晚到且余量不足的那次只退回这一条并写明原因，别人取走的不动。退回后只在技师本侧重试。"
        />

        <EmptyPanel
          v-if="pieceDraws.length === 0"
          title="这件作品还没有取料道次"
          description="每次取料单独记一道：选用哪批料、取多少、谁操作；落账后批次余量同步扣减并保存批次色号/配方快照。"
          action-text="记第一道取料"
          @action="openCreateDraw(null)"
        />

        <ul v-else class="draw-list">
          <li
            v-for="row in pieceDraws"
            :key="row.id"
            class="draw-item"
            :class="{ 'is-rejected': row.state === '已退回', 'is-migrated': row.migrated === true }"
          >
            <span class="draw-seq">#{{ row.seq }}</span>
            <div class="draw-main">
              <div class="draw-title">
                <b>{{ row.batchColorCode }}</b>
                <el-tag size="small" type="info" effect="plain">第 {{ row.batchCycle }} 轮快照</el-tag>
                <el-tag size="small" :type="row.state === '已落账' ? 'success' : 'danger'" effect="dark">
                  {{ row.state === '已落账' ? '已落账' : `已退回 · ${row.rejectReason}` }}
                </el-tag>
                <el-tag v-if="row.migrated" size="small" type="warning" effect="plain">旧数据回填</el-tag>
              </div>
              <div class="draw-sub">
                取料 <b>{{ row.drawKg }} kg</b> · 操作人 {{ row.operator || '—' }} · 落账时配方：{{ row.batchRecipe || '—' }}
              </div>
              <div v-if="row.state === '已退回'" class="draw-reject">
                {{ row.rejectReason === '批次不存在' ? '该批次已不存在（删除或换批）' : `当时余量仅 ${row.remainAtReject} kg，不足 ${row.drawKg} kg（可能他人先取走）` }}
                · 批次与别人的取料未改动
              </div>
            </div>
            <div class="draw-actions">
              <template v-if="row.state === '已退回'">
                <el-button size="small" type="danger" @click="openRetryDraw(row)">改批次/用量后重试</el-button>
                <el-button size="small" type="primary" plain @click="quickRetryDraw(row)">按本侧重试</el-button>
                <el-button size="small" text @click="discardDraw(row)">撤销</el-button>
              </template>
            </div>
          </li>
        </ul>
      </el-card>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '新增吹制工序' : '编辑吹制工序'" width="640px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="工序序号" prop="seq">
              <el-input-number v-model="form.seq" :min="1" :max="99" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="工序名称" prop="name">
              <el-select v-model="form.name" style="width: 100%">
                <el-option v-for="item in STEP_NAME_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="工序状态" prop="state">
              <el-select v-model="form.state" style="width: 100%">
                <el-option v-for="item in STEP_STATE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="温度（℃）" prop="tempC">
              <el-input-number v-model="form.tempC" :min="200" :max="1800" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="时长（分钟）" prop="durationMin">
              <el-input-number v-model="form.durationMin" :min="0.1" :max="600" :step="0.5" :precision="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="操作人" prop="operator">
              <el-input v-model="form.operator" placeholder="如：林曦" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="如：分三次吹气成型 / 夹持颈部收细" />
        </el-form-item>
        <el-alert
          :type="tempCheck.ok ? 'success' : 'warning'"
          show-icon
          :closable="false"
          :title="tempCheck.message"
          :description="
            piece === null
              ? ''
              : `「${piece.craft}」适宜温度区间 ${CRAFT_TEMP_RANGE[piece.craft].min}–${CRAFT_TEMP_RANGE[piece.craft].max} ℃；所选窑炉上限 ${furnace?.maxTempC ?? 1250} ℃。`
          "
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="drawDialog"
      :title="editingDrawId === null ? '记取料道次（技师账）' : '重试取料道次（仅技师侧）'"
      width="560px"
    >
      <el-form ref="drawFormRef" :model="drawForm" :rules="drawRules" label-width="110px">
        <el-row :gutter="12">
          <el-col :span="10">
            <el-form-item label="取料道次" prop="seq">
              <el-input-number v-model="drawForm.seq" :min="1" :max="99" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="14">
            <el-form-item label="操作人" prop="operator">
              <el-input v-model="drawForm.operator" placeholder="如：林曦" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="料液批次" prop="batchId">
          <el-select v-model="drawForm.batchId" filterable style="width: 100%" placeholder="选择用哪批料">
            <el-option v-for="item in drawBatchOptions" :key="item.id" :value="item.id" :label="item.label" />
          </el-select>
        </el-form-item>
        <el-form-item label="取料量（kg）" prop="drawKg">
          <el-input-number v-model="drawForm.drawKg" :min="0.1" :max="500" :step="0.1" :precision="1" style="width: 100%" />
        </el-form-item>
        <el-alert
          :type="drawForm.drawKg > selectedBatchRemain ? 'error' : 'success'"
          show-icon
          :closable="false"
          :title="
            drawForm.drawKg > selectedBatchRemain
              ? `该批次当前余量仅 ${selectedBatchRemain} kg，现在提交将只退回本道次并写明「余量不足」，不会扣穿批次、不影响别人。`
              : `该批次当前余量 ${selectedBatchRemain} kg，足够本次取料；保存时按落账当时余量最终判定。`
          "
          :description="editingDrawId === null ? '' : '重试只会重新提交技师这一条取料道次，熔化车间侧其它记录与别人的取料不动。'"
        />
      </el-form>
      <template #footer>
        <el-button @click="drawDialog = false">取消</el-button>
        <el-button :type="editingDrawId === null ? 'primary' : 'danger'" :loading="drawSubmitting" @click="submitDraw">
          {{ editingDrawId === null ? '保存取料' : '本侧重试' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 14px 0;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.step-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  background: #ffffff;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.step-item.is-drag-over {
  border-color: #c2571a;
  box-shadow: 0 0 0 2px rgba(194, 87, 26, 0.15);
}

.step-item.is-current {
  background: #fffaf6;
}

.step-seq {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #f2f4f7;
  font-size: 12px;
  font-weight: 600;
  color: #5b6b7a;
}

.step-grip {
  color: #c0c4cc;
  cursor: grab;
}

.step-main {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.step-sub {
  font-size: 12px;
  color: #8b95a1;
}

.step-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.draw-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.draw-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  background: #ffffff;
}

.draw-item.is-rejected {
  border-color: #f56c6c;
  background: #fef0f0;
}

.draw-item.is-migrated {
  border-style: dashed;
}

.draw-seq {
  display: grid;
  place-items: center;
  min-width: 42px;
  height: 28px;
  padding: 0 8px;
  border-radius: 14px;
  background: #f2f4f7;
  font-size: 12px;
  font-weight: 600;
  color: #5b6b7a;
}

.draw-main {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.draw-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.draw-sub {
  font-size: 12px;
  color: #5b6b7a;
}

.draw-reject {
  font-size: 12px;
  color: #c0392b;
}

.draw-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
