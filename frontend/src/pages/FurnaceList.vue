<script setup lang="ts">
/**
 * /furnaces 窑炉与料液台账（熔化车间那本账）
 * 批次上记投料量、配方、出料量与余量；出料只由技师落账取料道次时按当时余量扣减。
 * 支持回炉重熔 / 改配方（技师账旧道次不动）、本侧落账失败只按本侧重试，并按料液批次与技师账对账。
 * 消费模型：Furnace、GlassBatch、Draw；复用组件：<StageTag>、<EmptyPanel>、<FilterBar>、<StatBadge>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useFurnaceStore } from '@/stores/furnaceStore'
import {
  FUEL_TYPE_OPTIONS,
  FURNACE_STATE_OPTIONS,
  FURNACE_TYPE_OPTIONS,
  type FuelType,
  type Furnace,
  type FurnaceDraft,
  type FurnaceState,
  type FurnaceType,
} from '@/types/furnace'
import type { GlassBatch, GlassBatchDraft } from '@/types/batch'
import type { Draw } from '@/types/draw'
import { LOW_REMAIN_KG, isLowRemain } from '@/utils/thermal'
import { today } from '@/utils/id'
import { reconcileLedgers, type BatchReconcileRow } from '@/utils/reconcile'

const store = useFurnaceStore()

const furnaceDialog = ref(false)
const batchDialog = ref(false)
const remeltDialog = ref(false)
const recipeDialog = ref(false)
const submitting = ref(false)
const editingFurnaceId = ref<string | null>(null)
const editingBatchId = ref<string | null>(null)
const remeltTarget = ref<GlassBatch | null>(null)
const recipeTarget = ref<GlassBatch | null>(null)
const refillKg = ref(50)
const furnaceFormRef = ref<FormInstance>()
const batchFormRef = ref<FormInstance>()
const remeltFormRef = ref<FormInstance>()
const selectedFurnaceId = ref<string>('all')

const furnaceForm = reactive<FurnaceDraft>({
  code: '',
  type: '熔化炉',
  maxTempC: 1250,
  fuelType: '燃气',
  state: '停窑',
})

const batchForm = reactive<GlassBatchDraft>({
  furnaceId: '',
  colorCode: '',
  recipe: '',
  meltDate: today(),
  tempC: 1150,
  chargeKg: 200,
})

const remeltForm = reactive({ recipe: '', chargeKg: 200, meltDate: today(), tempC: 1150 })
const recipeForm = reactive({ recipe: '' })

const furnaceRules: FormRules<FurnaceDraft> = {
  code: [{ required: true, message: '请填写窑号', trigger: 'blur' }],
  type: [{ required: true, message: '请选择窑炉类型', trigger: 'change' }],
  maxTempC: [{ required: true, message: '请填写最高温度', trigger: 'blur' }],
  fuelType: [{ required: true, message: '请选择燃料类型', trigger: 'change' }],
  state: [{ required: true, message: '请选择运行状态', trigger: 'change' }],
}

const batchRules: FormRules<GlassBatchDraft> = {
  furnaceId: [{ required: true, message: '请选择所属窑炉', trigger: 'change' }],
  colorCode: [{ required: true, message: '请填写色号', trigger: 'blur' }],
  recipe: [{ required: true, message: '请填写配方', trigger: 'blur' }],
  meltDate: [{ required: true, message: '请选择熔化日期', trigger: 'change' }],
  tempC: [{ required: true, message: '请填写出料温度', trigger: 'blur' }],
  chargeKg: [{ required: true, message: '请填写投料量', trigger: 'blur' }],
}

const remeltRules: FormRules<typeof remeltForm> = {
  recipe: [{ required: true, message: '请填写本轮配方', trigger: 'blur' }],
  chargeKg: [{ required: true, message: '请填写本轮投料量', trigger: 'blur' }],
  meltDate: [{ required: true, message: '请选择重熔日期', trigger: 'change' }],
}

const batches = computed<GlassBatch[]>(() =>
  selectedFurnaceId.value === 'all'
    ? store.batches
    : store.batches.filter((row) => row.furnaceId === selectedFurnaceId.value)
)

const furnaceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(store.furnaces.map((row) => [row.id, `${row.code} · ${row.type}`]))
)

/** 按料液批次对账：熔化车间账（投料/出料/余量）↔ 技师账（已落账取料合计） */
const reconcile = computed(() => reconcileLedgers(batches.value, store.draws))

const reconcileRowsById = computed(() => new Map(reconcile.value.rows.map((row) => [row.batchId, row])))

const totals = computed(() => ({
  totalCharge: Math.round(store.batches.reduce((acc, row) => acc + row.chargeKg, 0) * 10) / 10,
  totalOut: Math.round(store.batches.reduce((acc, row) => acc + row.outKg, 0) * 10) / 10,
  totalRemain: Math.round(store.batches.reduce((acc, row) => acc + row.remainKg, 0) * 10) / 10,
  lowCount: store.lowRemainBatches.length,
  runningCount: store.furnaces.filter((row) => row.state === '运行').length,
  meltFurnaces: store.meltingFurnaces.length,
  annealFurnaces: store.annealingFurnaces.length,
}))

onMounted(() => {
  void store.loadAll()
})

/* ------------------------------ 窑炉 ------------------------------ */

function openCreateFurnace(): void {
  editingFurnaceId.value = null
  Object.assign(furnaceForm, {
    code: '',
    type: '熔化炉' as FurnaceType,
    maxTempC: 1250,
    fuelType: '燃气' as FuelType,
    state: '停窑' as FurnaceState,
  })
  furnaceDialog.value = true
}

function openEditFurnace(row: Furnace): void {
  editingFurnaceId.value = row.id
  Object.assign(furnaceForm, { code: row.code, type: row.type, maxTempC: row.maxTempC, fuelType: row.fuelType, state: row.state })
  furnaceDialog.value = true
}

async function submitFurnace(): Promise<void> {
  if (furnaceFormRef.value === undefined) return
  const valid = await furnaceFormRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingFurnaceId.value === null) {
      const draft = { ...furnaceForm }
      const ok = await store.runSide('create-furnace', `新建窑炉 ${draft.code}`, { draft }, () => store.createFurnace(draft))
      if (ok) {
        ElMessage.success('窑炉已登记')
        furnaceDialog.value = false
      } else {
        ElMessage.warning('熔化车间侧保存失败，已挂本侧重试队列（技师侧不动）')
      }
    } else {
      const id = editingFurnaceId.value
      const draft = { ...furnaceForm }
      const ok = await store.runSide('edit-furnace', `编辑窑炉 ${draft.code}`, { furnaceId: id, draft }, () =>
        store.updateFurnace(id, draft),
      )
      if (ok) {
        ElMessage.success('窑炉信息已更新')
        furnaceDialog.value = false
      } else {
        ElMessage.warning('熔化车间侧保存失败，已挂本侧重试队列（技师侧不动）')
      }
    }
  } finally {
    submitting.value = false
  }
}

async function deleteFurnace(row: Furnace): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除「${row.code}」及其全部料液批次，且不可恢复。技师历史取料道次保留并标批次缺失。`, '确认删除窑炉？', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await store.deleteFurnace(row.id)
  ElMessage.success('窑炉已删除')
}

/* ------------------------------ 料液批次 ------------------------------ */

function openCreateBatch(): void {
  editingBatchId.value = null
  Object.assign(batchForm, {
    furnaceId: store.meltingFurnaces[0]?.id ?? store.furnaces[0]?.id ?? '',
    colorCode: '',
    recipe: '',
    meltDate: today(),
    tempC: 1150,
    chargeKg: 200,
  })
  batchDialog.value = true
}

function openEditBatch(row: GlassBatch): void {
  editingBatchId.value = row.id
  Object.assign(batchForm, {
    furnaceId: row.furnaceId,
    colorCode: row.colorCode,
    recipe: row.recipe,
    meltDate: row.meltDate,
    tempC: row.tempC,
    chargeKg: row.chargeKg,
  })
  batchDialog.value = true
}

async function submitBatch(): Promise<void> {
  if (batchFormRef.value === undefined) return
  const valid = await batchFormRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingBatchId.value === null) {
      const draft = { ...batchForm }
      const ok = await store.runSide('create-batch', `登记料液批次 ${draft.colorCode}`, { batchDraft: draft }, () =>
        store.createBatch(draft),
      )
      if (ok) {
        ElMessage.success('料液批次已登记（投料量即初始余量，出料量为 0）')
        batchDialog.value = false
      } else {
        ElMessage.warning('熔化车间侧登记失败，已挂本侧重试队列（技师侧不动）')
      }
    } else {
      const id = editingBatchId.value
      const draft = { ...batchForm }
      const ok = await store.runSide('edit-batch', `编辑批次 ${draft.colorCode}`, { batchId: id, batchDraft: draft }, () =>
        store.updateBatchMeta(id, draft),
      )
      if (ok) {
        ElMessage.success('料液批次基础信息已更新（投料 / 出料 / 余量请走补料或回炉重熔）')
        batchDialog.value = false
      } else {
        ElMessage.warning('熔化车间侧保存失败，已挂本侧重试队列（技师侧不动）')
      }
    }
  } finally {
    submitting.value = false
  }
}

async function deleteBatch(row: GlassBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认从熔化车间账删除料液批次「${row.colorCode}」？技师侧取料道次不会删除，将在对账中标为「批次缺失」。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await store.deleteBatch(row.id)
  ElMessage.success('料液批次已删除')
}

async function submitRefill(row: GlassBatch): Promise<void> {
  const kg = refillKg.value
  const ok = await store.runSide('refill', `${row.colorCode} 补料 ${kg} kg`, { batchId: row.id, kg }, () => store.refill(row.id, kg))
  ElMessage[ok ? 'success' : 'warning'](ok ? store.lastMessage : '补料落账失败，已挂本侧重试队列')
}

/* ------------------------------ 回炉重熔 / 改配方 ------------------------------ */

function openRemelt(row: GlassBatch): void {
  remeltTarget.value = row
  Object.assign(remeltForm, { recipe: row.recipe, chargeKg: Math.max(100, Math.ceil(row.chargeKg)), meltDate: today(), tempC: row.tempC })
  remeltDialog.value = true
}

async function submitRemelt(): Promise<void> {
  if (remeltFormRef.value === undefined || remeltTarget.value === null) return
  const valid = await remeltFormRef.value.validate().catch(() => false)
  if (!valid) return
  const target = remeltTarget.value
  try {
    await ElMessageBox.confirm(
      `「${target.colorCode}」将回炉重熔：开第 ${target.cycle + 1} 轮、出料量清零、余量恢复为投料量 ${remeltForm.chargeKg} kg。技师账第 ${target.cycle} 轮及之前的取料道次照旧保留。`,
      '确认回炉重熔？',
      { type: 'warning', confirmButtonText: '确认重熔', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    const payload = { ...remeltForm }
    const ok = await store.runSide('remelt', `${target.colorCode} 回炉重熔`, { batchId: target.id, ...payload }, () =>
      store.remelt(target.id, payload),
    )
    if (ok) {
      ElMessage.success(store.lastMessage)
      remeltDialog.value = false
    } else {
      ElMessage.warning('回炉重熔落账失败，已挂本侧重试队列（技师侧不动）')
    }
  } finally {
    submitting.value = false
  }
}

function openRecipe(row: GlassBatch): void {
  recipeTarget.value = row
  recipeForm.recipe = row.recipe
  recipeDialog.value = true
}

async function submitRecipe(): Promise<void> {
  if (recipeTarget.value === null) return
  const target = recipeTarget.value
  const recipe = recipeForm.recipe.trim()
  if (recipe === '') {
    ElMessage.warning('配方不能为空')
    return
  }
  const ok = await store.runSide('recipe', `${target.colorCode} 改配方`, { batchId: target.id, recipe }, () =>
    store.changeRecipe(target.id, recipe),
  )
  if (ok) {
    ElMessage.success(store.lastMessage)
    recipeDialog.value = false
  } else {
    ElMessage.warning('改配方落账失败，已挂本侧重试队列（技师侧不动）')
  }
}

/* ------------------------------ 本侧重试 ------------------------------ */

async function retryPending(id: string): Promise<void> {
  const ok = await store.retryPendingOp(id)
  ElMessage[ok ? 'success' : 'warning'](ok ? '本侧重试成功，已移出重试队列' : '重试仍失败，保留在本侧队列')
}

function dismissPending(id: string): void {
  store.dropPendingOp(id)
}

function batchRowClass({ row }: { row: GlassBatch }): string {
  const report = reconcileRowsById.value.get(row.id)
  if (report !== undefined && !report.balanced) return 'row-diff'
  return isLowRemain(row.remainKg) ? 'row-low-remain' : ''
}

function reconcileRowClass({ row }: { row: BatchReconcileRow }): string {
  return row.balanced ? '' : 'row-diff'
}

function orphanDrawText(group: { draws: Draw[] }): string {
  return group.draws
    .map((d) => `${d.pieceName}#${d.seq}(${d.state === '已落账' ? `${d.drawKg}kg` : '已退回'})`)
    .join('，')
}

function handleFurnaceFilter(key: string, value: string): void {
  if (key === 'type') store.setFilters({ type: value as FurnaceType | 'all' })
  if (key === 'state') store.setFilters({ state: value as FurnaceState | 'all' })
}

function diffTagType(row: GlassBatch): 'success' | 'danger' | 'warning' | 'info' {
  const report = reconcileRowsById.value.get(row.id)
  if (report === undefined || report.balanced) return 'success'
  return report.migrated ? 'warning' : 'danger'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="窑炉总数" :value="store.furnaces.length" suffix="台" tone="primary" icon="Histogram" />
      <StatBadge label="熔化/坩埚炉" :value="totals.meltFurnaces" suffix="台" tone="warning" icon="DataLine" />
      <StatBadge label="退火窑" :value="totals.annealFurnaces" suffix="台" tone="info" icon="Histogram" />
      <StatBadge label="料液批次" :value="store.batches.length" suffix="批" tone="primary" icon="PieChart" />
      <StatBadge label="投料总量" :value="totals.totalCharge" suffix="kg" tone="info" icon="Coin" />
      <StatBadge label="出料累计" :value="totals.totalOut" suffix="kg" tone="warning" icon="DataLine" />
      <StatBadge label="剩余总量" :value="totals.totalRemain" suffix="kg" tone="success" icon="TrendCharts" />
      <StatBadge
        label="对账有差"
        :value="reconcile.diffCount"
        suffix="批"
        :tone="reconcile.diffCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="技师已落账取料合计与车间出料量 / 余量对不上的批次数"
      />
    </div>

    <el-alert
      v-if="store.pendingOps.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`熔化车间侧有 ${store.pendingOps.length} 条落账失败待办，只在本侧重试，技师侧不动`"
    >
      <template #default>
        <div class="pending-list">
          <div v-for="op in store.pendingOps" :key="op.id" class="pending-item">
            <span>{{ op.label }}（{{ op.lastError }}）</span>
            <el-space>
              <el-button size="small" type="primary" @click="retryPending(op.id)">按本侧重试</el-button>
              <el-button size="small" text @click="dismissPending(op.id)">移除</el-button>
            </el-space>
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="store.lowRemainBatches.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${store.lowRemainBatches.length} 批料液剩余量低于 ${LOW_REMAIN_KG} kg，请安排补料`"
    >
      <template #default>
        <div class="low-list">
          <div v-for="row in store.lowRemainBatches" :key="row.id">
            {{ row.colorCode }}（{{ furnaceLabel[row.furnaceId] ?? '未知窑炉' }}）· 第 {{ row.cycle }} 轮 ·
            投料 {{ row.chargeKg }} / 出料 {{ row.outKg }} / 剩余 <b>{{ row.remainKg }} kg</b>
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">窑炉台账</span>
          <el-button type="primary" @click="openCreateFurnace">
            <el-icon><Plus /></el-icon>
            <span>新建窑炉</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="store.filters.keyword"
        :fields="[
          { key: 'type', label: '窑炉类型', options: FURNACE_TYPE_OPTIONS as unknown as string[] },
          { key: 'state', label: '运行状态', options: FURNACE_STATE_OPTIONS as unknown as string[] },
        ]"
        :values="{ type: store.filters.type, state: store.filters.state }"
        :result-text="`命中 ${store.visibleFurnaces.length} / ${store.furnaces.length} 台`"
        @update:keyword="(value: string) => store.setFilters({ keyword: value })"
        @change="handleFurnaceFilter"
        @reset="store.resetFilters()"
      />

      <EmptyPanel
        v-if="store.ready && store.furnaces.length === 0"
        title="还没有窑炉"
        description="先登记熔化炉 / 坩埚炉 / 退火窑，再挂料液批次或分配退火窑位。"
        action-text="新建第一台窑炉"
        @action="openCreateFurnace"
      />

      <el-table v-else v-loading="!store.ready" :data="store.visibleFurnaces" row-key="id" stripe>
        <el-table-column label="窑号 / 类型" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ row.code }}</span>
              <span class="cell-sub">{{ row.type }} · {{ row.fuelType }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="130">
          <template #default="{ row }">
            <el-space>
              <StageTag :furnace-state="row.state" size="small" />
              <el-tag size="small" :type="row.type === '退火窑' ? 'primary' : 'warning'">{{ row.type }}</el-tag>
            </el-space>
          </template>
        </el-table-column>
        <el-table-column label="最高温度" width="110" align="right">
          <template #default="{ row }">{{ row.maxTempC }} ℃</template>
        </el-table-column>
        <el-table-column label="料液批次" width="100" align="right">
          <template #default="{ row }">{{ store.statOf(row.id).batchCount }} 批</template>
        </el-table-column>
        <el-table-column label="投料 / 出料" width="150" align="right">
          <template #default="{ row }">
            <span class="cell-sub">{{ store.statOf(row.id).totalChargeKg }} / {{ store.statOf(row.id).totalOutKg }} kg</span>
          </template>
        </el-table-column>
        <el-table-column label="剩余合计" width="110" align="right">
          <template #default="{ row }">{{ store.statOf(row.id).totalRemainKg }} kg</template>
        </el-table-column>
        <el-table-column label="关联作品" width="100" align="right">
          <template #default="{ row }">{{ store.statOf(row.id).pieceCount }} 件</template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEditFurnace(row)">编辑</el-button>
            <el-button link type="primary" size="small" @click="openCreateBatch">挂料液</el-button>
            <el-button link type="danger" size="small" @click="deleteFurnace(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">熔化车间账 · 料液批次（投料量 / 配方 / 出料量 / 余量）</span>
          <el-space>
            <el-select v-model="selectedFurnaceId" style="width: 190px" size="small">
              <el-option value="all" label="全部窑炉" />
              <el-option v-for="item in store.furnaces" :key="item.id" :value="item.id" :label="`${item.code} · ${item.type}`" />
            </el-select>
            <el-button type="primary" @click="openCreateBatch" :disabled="store.meltingFurnaces.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记料液批次</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <EmptyPanel
        v-if="store.batches.length === 0 && !store.loading"
        title="还没有料液批次"
        description="熔化车间按批次登记投料量与配方；技师在工序页落账取料道次时按当时余量扣减出料，这里只记账不直接取料。"
        action-text="登记第一批料液"
        @action="openCreateBatch"
      />

      <el-table v-else v-loading="store.loading" :data="batches" row-key="id" stripe :row-class-name="batchRowClass">
        <el-table-column label="色号 / 配方" min-width="260">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ row.colorCode }}</span>
              <span class="cell-sub">{{ row.recipe }}</span>
              <el-space :size="4">
                <el-tag size="small" type="info" effect="plain">第 {{ row.cycle }} 轮</el-tag>
                <el-tag size="small" type="info" effect="plain">版本 v{{ row.version }}</el-tag>
                <el-tag v-if="row.migrated" size="small" type="warning" effect="plain">历史迁移</el-tag>
              </el-space>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所属窑炉" min-width="150">
          <template #default="{ row }">{{ furnaceLabel[row.furnaceId] ?? '（窑炉已删除）' }}</template>
        </el-table-column>
        <el-table-column prop="meltDate" label="熔化日期" width="110" />
        <el-table-column label="出料温度" width="100" align="right">
          <template #default="{ row }">{{ row.tempC }} ℃</template>
        </el-table-column>
        <el-table-column label="投料量" width="100" align="right">
          <template #default="{ row }">{{ row.chargeKg }} kg</template>
        </el-table-column>
        <el-table-column label="出料量" width="100" align="right">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': (reconcileRowsById.get(row.id)?.ledgerDiffKg ?? 0) !== 0 }">{{ row.outKg }} kg</span>
          </template>
        </el-table-column>
        <el-table-column label="余量" width="120" align="right">
          <template #default="{ row }">
            <el-tag :type="isLowRemain(row.remainKg) ? 'danger' : 'success'" size="small">{{ row.remainKg }} kg</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对账" width="120">
          <template #default="{ row }">
            <el-tag :type="diffTagType(row)" size="small">
              {{ (reconcileRowsById.get(row.id)?.balanced ?? true) ? '对平' : '有差' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="熔化车间操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-space :size="4" wrap>
              <el-input-number v-model="refillKg" :min="1" :max="2000" :step="10" size="small" style="width: 105px" />
              <el-button size="small" @click="submitRefill(row)">补料</el-button>
              <el-button size="small" type="warning" plain @click="openRemelt(row)">回炉重熔</el-button>
              <el-button size="small" type="primary" link @click="openRecipe(row)">改配方</el-button>
              <el-button size="small" type="primary" link @click="openEditBatch(row)">编辑</el-button>
              <el-button size="small" type="danger" link @click="deleteBatch(row)">删除</el-button>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 按料液批次对账 -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">两本账对账（按料液批次）</span>
          <el-space>
            <el-tag :type="reconcile.balanced ? 'success' : 'danger'" effect="dark" size="large">
              {{ reconcile.balanced ? '全部对平' : `${reconcile.diffCount} 批有差 · ${reconcile.orphanCount} 道批次缺失` }}
            </el-tag>
          </el-space>
        </div>
      </template>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="mb-14"
        title="对账口径：技师「已落账」取料量之和 = 批次出料量；投料量 - 出料量 = 批次余量。被退回的取料道次不计入出料量。"
      />

      <el-table :data="reconcile.rows" row-key="batchId" stripe :row-class-name="reconcileRowClass">
        <el-table-column label="色号 / 轮次" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ row.colorCode }}</span>
              <span class="cell-sub">{{ row.recipe }}</span>
              <el-space :size="4">
                <el-tag size="small" type="info" effect="plain">第 {{ row.cycle }} 轮</el-tag>
                <el-tag v-if="row.migrated" size="small" type="warning" effect="plain">历史迁移</el-tag>
              </el-space>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="车间投料" width="100" align="right">
          <template #default="{ row }">{{ row.chargeKg }} kg</template>
        </el-table-column>
        <el-table-column label="车间出料" width="100" align="right">
          <template #default="{ row }">{{ row.outKg }} kg</template>
        </el-table-column>
        <el-table-column label="车间余量" width="100" align="right">
          <template #default="{ row }">{{ row.remainKg }} kg</template>
        </el-table-column>
        <el-table-column label="技师本轮取料" width="140" align="right">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': !row.balanced && row.diffSide !== 'melt' }">{{ row.techDrawKg }} kg</span>
            <span class="cell-sub"> · {{ row.techDrawCount }} 道</span>
          </template>
        </el-table-column>
        <el-table-column label="历史轮次取料" width="130" align="right">
          <template #default="{ row }">
            <span class="cell-sub">{{ row.techHistoryKg }} kg · {{ row.techHistoryCount }} 道（照旧）</span>
          </template>
        </el-table-column>
        <el-table-column label="取料账差" width="110" align="right">
          <template #default="{ row }">
            <el-tag size="small" :type="Math.abs(row.ledgerDiffKg) > 0.05 ? 'danger' : 'success'">
              {{ row.ledgerDiffKg > 0 ? '+' : '' }}{{ row.ledgerDiffKg }} kg
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="余量差" width="110" align="right">
          <template #default="{ row }">
            <el-tag size="small" :type="Math.abs(row.remainDiffKg) > 0.05 ? 'danger' : 'success'">
              {{ row.remainDiffKg > 0 ? '+' : '' }}{{ row.remainDiffKg }} kg
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="退回道次" width="90" align="right">
          <template #default="{ row }">
            <el-badge v-if="row.rejectedCount > 0" :value="row.rejectedCount" type="warning" />
            <span v-else class="cell-sub">0</span>
          </template>
        </el-table-column>
        <el-table-column label="差异说明（差在哪批）" min-width="320">
          <template #default="{ row }">
            <span v-if="row.balanced" class="cell-ok">两本账对平</span>
            <ul v-else class="issue-list">
              <li v-for="(issue, i) in row.issues" :key="i">{{ issue }}</li>
            </ul>
          </template>
        </el-table-column>
      </el-table>

      <template v-if="reconcile.orphans.length > 0">
        <el-divider content-position="left">技师账引用了已删除 / 缺失的批次</el-divider>
        <el-table :data="reconcile.orphans" row-key="batchId" stripe class="row-diff-table">
          <el-table-column prop="batchId" label="缺失批次 id" min-width="220" />
          <el-table-column label="取料道次" width="110" align="right">
            <template #default="{ row }">{{ row.count }} 道</template>
          </el-table-column>
          <el-table-column label="已落账用量" width="120" align="right">
            <template #default="{ row }">{{ row.totalKg }} kg</template>
          </el-table-column>
          <el-table-column label="涉及取料道次" min-width="360">
            <template #default="{ row }">
              <span class="cell-sub">{{ orphanDrawText(row) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-card>

    <el-dialog v-model="furnaceDialog" :title="editingFurnaceId === null ? '新建窑炉' : '编辑窑炉'" width="580px">
      <el-form ref="furnaceFormRef" :model="furnaceForm" :rules="furnaceRules" label-width="120px">
        <el-form-item label="窑号" prop="code">
          <el-input v-model="furnaceForm.code" placeholder="如：KILN-03 / AN-02" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="窑炉类型" prop="type">
              <el-select v-model="furnaceForm.type" style="width: 100%">
                <el-option v-for="item in FURNACE_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="最高温度（℃）" prop="maxTempC">
              <el-input-number v-model="furnaceForm.maxTempC" :min="100" :max="1800" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="燃料类型" prop="fuelType">
              <el-select v-model="furnaceForm.fuelType" style="width: 100%">
                <el-option v-for="item in FUEL_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="运行状态" prop="state">
              <el-select v-model="furnaceForm.state" style="width: 100%">
                <el-option v-for="item in FURNACE_STATE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          v-if="furnaceForm.type === '退火窑'"
          type="success"
          show-icon
          :closable="false"
          title="退火窑保存后会自动进入窑位池（A1–C3 共 9 个窑位），可在退火编排页分配。"
        />
      </el-form>
      <template #footer>
        <el-button @click="furnaceDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitFurnace">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDialog" :title="editingBatchId === null ? '登记料液批次（熔化车间账）' : '编辑料液批次基础信息'" width="620px">
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="120px">
        <el-form-item label="所属窑炉" prop="furnaceId">
          <el-select v-model="batchForm.furnaceId" style="width: 100%">
            <el-option
              v-for="item in store.meltingFurnaces"
              :key="item.id"
              :value="item.id"
              :label="`${item.code} · ${item.type} · 上限 ${item.maxTempC} ℃`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="色号" prop="colorCode">
              <el-input v-model="batchForm.colorCode" placeholder="如：G-101" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="熔化日期" prop="meltDate">
              <el-date-picker v-model="batchForm.meltDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="配方" prop="recipe">
          <el-input v-model="batchForm.recipe" type="textarea" :rows="2" placeholder="如：钠钙玻璃基础料 + 氧化钴 0.3%" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="出料温度（℃）" prop="tempC">
              <el-input-number v-model="batchForm.tempC" :min="600" :max="1800" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="投料量（kg）" prop="chargeKg">
              <el-input-number v-model="batchForm.chargeKg" :min="0" :max="5000" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          v-if="editingBatchId === null"
          type="info"
          show-icon
          :closable="false"
          title="新批次：投料量即初始余量，出料量从 0 起；后续余量只由技师落账取料扣减或本侧补料 / 回炉重熔改变。"
        />
        <el-alert
          v-else
          type="warning"
          show-icon
          :closable="false"
          title="编辑只改基础信息；改配方请用「改配方」（旧取料道次保留原配方快照），重新配料请用「回炉重熔」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="remeltDialog" title="回炉重熔（开新一轮）" width="560px">
      <el-form ref="remeltFormRef" :model="remeltForm" :rules="remeltRules" label-width="120px">
        <el-alert
          type="warning"
          show-icon
          :closable="false"
          class="mb-14"
          :title="remeltTarget ? `「${remeltTarget.colorCode}」当前为第 ${remeltTarget.cycle} 轮：出料 ${remeltTarget.outKg} kg / 余量 ${remeltTarget.remainKg} kg；重熔后开第 ${remeltTarget.cycle + 1} 轮。` : ''"
          description="技师那本账旧轮次的取料道次连同批次快照照旧保留，对账按新轮次的出料量累计。"
        />
        <el-form-item label="本轮配方" prop="recipe">
          <el-input v-model="remeltForm.recipe" type="textarea" :rows="2" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="投料量（kg）" prop="chargeKg">
              <el-input-number v-model="remeltForm.chargeKg" :min="0" :max="5000" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="重熔日期" prop="meltDate">
              <el-date-picker v-model="remeltForm.meltDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出料温度（℃）">
              <el-input-number v-model="remeltForm.tempC" :min="600" :max="1800" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="remeltDialog = false">取消</el-button>
        <el-button type="warning" :loading="submitting" @click="submitRemelt">确认重熔</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="recipeDialog" :title="`改配方 · ${recipeTarget?.colorCode ?? ''}`" width="520px">
      <el-form label-width="90px">
        <el-form-item label="新配方">
          <el-input v-model="recipeForm.recipe" type="textarea" :rows="3" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="配方更新后批次版本号 +1；技师已落账取料道次仍保留其落账时的配方快照，不受影响。"
        />
      </el-form>
      <template #footer>
        <el-button @click="recipeDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRecipe">保存配方</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
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

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-strong {
  font-weight: 600;
  color: #1d2b3a;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.cell-ok {
  color: #1f8a4c;
  font-size: 12px;
}

.issue-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  color: #c0392b;
  line-height: 1.7;
}

.low-list,
.pending-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.8;
}

.pending-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}

:deep(.row-low-remain td) {
  background-color: #fff7f2 !important;
}

:deep(.row-diff td) {
  background-color: #fef0f0 !important;
}
</style>
