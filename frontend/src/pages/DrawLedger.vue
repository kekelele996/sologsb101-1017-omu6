<script setup lang="ts">
/**
 * /draws 取料台账（技师账）
 * 每件作品的取料道次：用哪批料、取多少、操作人、取料时间。
 * 保存时在同一事务内按批次当时余量扣减；两个终端同时保存时晚到的一条只退回本道并写明余量不足，
 * 别人已取走的不动。退回道次只按技师本侧重试，熔化侧不补偿。批次回炉/改配方后历史道次照旧保留。
 * 消费模型：MaterialDraw、Piece、GlassBatch；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useDrawStore } from '@/stores/drawStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import type { MaterialDraw, MaterialDrawDraft } from '@/types/draw'
import { nowLocalInput } from '@/utils/id'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const drawStore = useDrawStore()
const furnaceStore = useFurnaceStore()
const pieceStore = usePieceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
/** retryTarget 非空表示在对「已退回」道次做本侧重试 */
const retryTarget = ref<MaterialDraw | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<MaterialDrawDraft>({
  pieceId: '',
  batchId: '',
  kg: 5,
  operator: '',
  drawnAt: nowLocalInput(),
  remark: '',
})

const rules: FormRules<MaterialDrawDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  batchId: [{ required: true, message: '请选择料液批次', trigger: 'change' }],
  kg: [{ required: true, message: '请填写取料量', trigger: 'blur' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
  drawnAt: [{ required: true, message: '请选择取料时间', trigger: 'change' }],
}

const pieceFilter = ref<string>('all')
const stateFilter = ref<MaterialDraw['state'] | 'all'>('all')
const keyword = ref('')

onMounted(() => {
  void furnaceStore.loadAll()
  void pieceStore.loadAll()
  void drawStore.loadAll()
  const queryPiece = String(route.query.piece ?? '')
  if (queryPiece !== '') pieceFilter.value = queryPiece
})

watch(pieceFilter, (value) => {
  drawStore.setFilters({ pieceId: value })
})
watch(stateFilter, (value) => {
  drawStore.setFilters({ state: value })
})
watch(keyword, (value) => {
  drawStore.setFilters({ keyword: value })
})

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft} · ${row.artist}`]))
)

const batchLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(
    furnaceStore.batches.map((row) => [
      row.id,
      `${row.colorCode} · 余 ${row.remainKg} kg${row.state === '已回炉' ? ' · 已回炉' : ''}`,
    ])
  )
)

/** 可选批次：在用优先；退回重试时允许看到已回炉批以便改选 */
const selectableBatches = computed(() =>
  furnaceStore.batches
    .slice()
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === '在用' ? -1 : 1
      return b.meltDate.localeCompare(a.meltDate)
    })
)

/** 登记表单选中的批次实时余量（展示「按当时余量扣」的那个余量） */
const selectedBatch = computed(() => furnaceStore.batches.find((row) => row.id === form.batchId) ?? null)

const filteredDraws = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return drawStore.draws
    .filter((row) => {
      if (pieceFilter.value !== 'all' && row.pieceId !== pieceFilter.value) return false
      if (stateFilter.value !== 'all' && row.state !== stateFilter.value) return false
      if (key === '') return true
      return (
        (pieceLabel.value[row.pieceId] ?? '作品已删除').toLowerCase().includes(key) ||
        (batchLabel.value[row.batchId] ?? '').toLowerCase().includes(key) ||
        row.operator.toLowerCase().includes(key) ||
        String(row.kg).includes(key) ||
        row.rejectReason.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.drawnAt.localeCompare(a.drawnAt) || b.drawSeq - a.drawSeq)
})

const stats = computed(() => ({
  total: drawStore.draws.length,
  posted: drawStore.postedDraws.length,
  returned: drawStore.returnedDraws.length,
  postedKg: drawStore.totalPostedKg,
}))

function syncBatchFromPiece(pieceId: string): void {
  const piece = pieceStore.pieces.find((row) => row.id === pieceId)
  if (piece !== undefined && piece.batchId !== '') {
    // 作品挂的批次作为默认建议，但技师可改选其他批次（一件作品可多次取不同批次的料）
    form.batchId = piece.batchId
    if (form.operator === '') form.operator = piece.artist
  }
}

function openCreate(): void {
  retryTarget.value = null
  const preselectPiece = pieceFilter.value !== 'all' ? pieceFilter.value : pieceStore.pieces[0]?.id ?? ''
  Object.assign(form, {
    pieceId: preselectPiece,
    batchId: '',
    kg: 5,
    operator: '',
    drawnAt: nowLocalInput(),
    remark: '',
  })
  if (preselectPiece !== '') syncBatchFromPiece(preselectPiece)
  dialogVisible.value = true
}

/** 退回道次本侧重试：可改批次/取量等；只动技师这本账，熔化侧不补偿 */
function openRetry(row: MaterialDraw): void {
  retryTarget.value = row
  Object.assign(form, {
    pieceId: row.pieceId,
    batchId: row.batchId,
    kg: row.kg,
    operator: row.operator,
    drawnAt: row.drawnAt,
    remark: row.remark,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (retryTarget.value === null) {
      const result = await drawStore.register({ ...form })
      if (result.ok) {
        ElMessage.success(`已落账 ${result.draw.kg} kg，批次余量 ${result.remainKg} kg`)
      } else {
        // 晚到/余量不足：只退回这一条，别人取走的不动
        ElMessageBox.alert(result.reason, '本道已退回（余量不足）', {
          type: 'warning',
          confirmButtonText: '知道了',
        }).catch(() => undefined)
      }
    } else {
      const result = await drawStore.retry(retryTarget.value.id, { ...form })
      if (result.ok) {
        ElMessage.success(`重试成功，已落账 ${result.draw.kg} kg，批次余量 ${result.remainKg} kg`)
      } else {
        ElMessageBox.alert(result.reason, '重试仍被退回', {
          type: 'warning',
          confirmButtonText: '知道了',
        }).catch(() => undefined)
      }
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: MaterialDraw): Promise<void> {
  const warning =
    row.state === '已落账'
      ? '该道次已落账（批次余量已扣）。删除只移除技师这本账记录，不会回补余量，删除后该批出料量将与取料量之和对不上。'
      : '该道次为已退回状态（未扣料），删除不会影响任何批次余量。'
  try {
    await ElMessageBox.confirm(`确认删除第 ${row.drawSeq} 道取料？${warning}`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await drawStore.deleteDraw(row.id)
  ElMessage.success('取料道次已删除')
}

function resetFilters(): void {
  pieceFilter.value = 'all'
  stateFilter.value = 'all'
  keyword.value = ''
  drawStore.resetFilters()
}

function goSteps(pieceId: string): void {
  void router.push(ROUTES.steps(pieceId))
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="取料道次" :value="stats.total" suffix="道" tone="primary" icon="Histogram" />
      <StatBadge label="已落账" :value="stats.posted" suffix="道" tone="success" icon="DataLine" />
      <StatBadge
        label="已退回"
        :value="stats.returned"
        suffix="道"
        :tone="stats.returned > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="余量不足被晚到退回的道次，未扣料，可只按技师侧重试"
      />
      <StatBadge label="已落账取料量" :value="stats.postedKg" suffix="kg" tone="warning" icon="TrendCharts" />
    </div>

    <el-alert
      v-if="stats.returned > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${stats.returned} 道取料因余量不足被退回（本道未扣料，别人取走的不动），可在下方只按技师侧重试`"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">取料台账（技师账：批次 · 取量 · 操作人）</span>
          <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0 || furnaceStore.batches.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记取料道次</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          {
            key: 'state',
            label: '落账状态',
            options: ['已落账', '已退回'] as unknown as string[],
          },
        ]"
        :values="{ state: stateFilter }"
        :result-text="`命中 ${filteredDraws.length} / ${drawStore.draws.length} 道`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="(key: string, value: string) => { if (key === 'state') stateFilter = value as MaterialDraw['state'] | 'all' }"
        @reset="resetFilters"
      />

      <div class="piece-filter">
        <span class="cell-sub">按作品：</span>
        <el-select v-model="pieceFilter" size="small" style="width: 280px">
          <el-option value="all" label="全部作品" />
          <el-option
            v-for="piece in pieceStore.pieces"
            :key="piece.id"
            :value="piece.id"
            :label="`${piece.name} · ${piece.craft} · ${piece.artist}`"
          />
        </el-select>
      </div>

      <EmptyPanel
        v-if="drawStore.ready && drawStore.draws.length === 0"
        title="还没有取料道次"
        description="技师给每件作品的取料逐道登记：用哪批料、取多少、谁操作；保存时按批次当时余量原子扣减，余量不足只退回本道。"
        action-text="登记第一道取料"
        @action="openCreate"
      />

      <el-table v-else v-loading="drawStore.loading" :data="filteredDraws" row-key="id" stripe>
        <el-table-column label="作品 / 道次" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="goSteps(row.pieceId)">
                {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">第 {{ row.drawSeq }} 道取料{{ row.migrated ? ' · 旧数据迁移' : '' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="料液批次" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ batchLabel[row.batchId] ?? '（批次已删除）' }}</span>
              <span v-if="furnaceStore.batchById(row.batchId)?.state === '已回炉'" class="cell-sub">该批已回炉，道次照旧保留</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="取料量" width="110" align="right">
          <template #default="{ row }">
            <b>{{ row.kg }} kg</b>
          </template>
        </el-table-column>
        <el-table-column prop="operator" label="操作人" width="100" />
        <el-table-column prop="drawnAt" label="取料时间" min-width="160">
          <template #default="{ row }">{{ row.drawnAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="状态 / 说明" min-width="280">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-space>
                <el-tag size="small" :type="row.state === '已落账' ? 'success' : 'danger'" effect="dark">
                  {{ row.state }}
                </el-tag>
                <el-tag v-if="row.attempts > 1" size="small" type="warning">第 {{ row.attempts }} 次提交</el-tag>
              </el-space>
              <span v-if="row.state === '已退回'" class="cell-warn">{{ row.rejectReason }}</span>
              <span v-else-if="row.remark !== ''" class="cell-sub">{{ row.remark }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.state === '已退回'"
              link
              type="warning"
              size="small"
              @click="openRetry(row)"
            >
              本侧重试
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="retryTarget === null ? '登记取料道次' : `第 ${retryTarget.drawSeq} 道取料 · 本侧重试`"
      width="600px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="作品" prop="pieceId">
          <el-select
            v-model="form.pieceId"
            filterable
            style="width: 100%"
            :disabled="retryTarget !== null"
            @change="syncBatchFromPiece"
          >
            <el-option
              v-for="piece in pieceStore.pieces"
              :key="piece.id"
              :value="piece.id"
              :label="`${piece.name} · ${piece.craft} · ${piece.artist}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="料液批次" prop="batchId">
          <el-select v-model="form.batchId" filterable style="width: 100%">
            <el-option
              v-for="batch in selectableBatches"
              :key="batch.id"
              :value="batch.id"
              :label="batchLabel[batch.id]"
              :disabled="batch.state === '已回炉'"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="取料量（kg）" prop="kg">
              <el-input-number v-model="form.kg" :min="0.1" :max="5000" :step="0.5" :precision="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="操作人" prop="operator">
              <el-input v-model="form.operator" placeholder="如：林曦" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="取料时间" prop="drawnAt">
              <el-date-picker
                v-model="form.drawnAt"
                type="datetime"
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DDTHH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="如：首料蘸取三次 / 长颈瓶补料" />
        </el-form-item>
        <el-alert
          v-if="selectedBatch"
          :type="selectedBatch.state === '已回炉' ? 'error' : selectedBatch.remainKg < form.kg ? 'warning' : 'success'"
          show-icon
          :closable="false"
          :title="
            selectedBatch.state === '已回炉'
              ? '该批已回炉封账，提交后本道只会退回、不会扣料。'
              : `提交时按批次「${selectedBatch.colorCode}」当时余量 ${selectedBatch.remainKg} kg 原子扣减。`
          "
          :description="
            selectedBatch.state === '已回炉'
              ? ''
              : selectedBatch.remainKg < form.kg
                ? `当前申请 ${form.kg} kg 已超过余量，两个终端同时保存时晚到的一条只退回本道并写明余量不足，别人取走的不动。`
                : '与其他终端同时保存时，晚到的一条若余量不足只退回本道；退回后可只按技师侧重试，熔化侧不补偿。'
          "
        />
        <el-alert
          v-else
          type="warning"
          show-icon
          :closable="false"
          title="请先选择有效料液批次。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">
          {{ retryTarget === null ? '保存并落账' : '重试落账' }}
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
  font-size: 12px;
  color: #c0392b;
}

.piece-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 12px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
