<script setup lang="ts">
/**
 * /furnaces 窑炉与料液台账（熔化车间账）
 * 窑炉台账；料液批次上记投料量、配方、累计出料量（只读）与余量。
 * 取料不在本页直接扣——由技师在「取料台账」登记道次并按当时余量原子落账。
 * 支持补料、改配方（只改熔化账，技师历史道次不动）与回炉重熔（旧批封账、余量转入新批）。
 * 消费模型：Furnace、GlassBatch；复用组件：<StageTag>、<EmptyPanel>、<FilterBar>、<StatBadge>
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
import { LOW_REMAIN_KG, isLowRemain } from '@/utils/thermal'
import { today } from '@/utils/id'
import { ROUTES } from '@/router'
import { useRouter } from 'vue-router'

const store = useFurnaceStore()
const router = useRouter()

const furnaceDialog = ref(false)
const batchDialog = ref(false)
const remeltDialog = ref(false)
const submitting = ref(false)
const editingFurnaceId = ref<string | null>(null)
const editingBatchId = ref<string | null>(null)
const remeltTarget = ref<GlassBatch | null>(null)
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
  remainKg: 200,
  state: '在用',
})

const remeltForm = reactive({
  colorCode: '',
  recipe: '',
  meltDate: today(),
  tempC: 1150,
})

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
  remainKg: [{ required: true, message: '请填写盘点余量', trigger: 'blur' }],
}

const remeltRules: FormRules<typeof remeltForm> = {
  colorCode: [{ required: true, message: '请填写新批色号', trigger: 'blur' }],
  recipe: [{ required: true, message: '请填写新批配方', trigger: 'blur' }],
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

const totals = computed(() => ({
  totalRemain: Math.round(store.batches.reduce((acc, row) => acc + row.remainKg, 0) * 10) / 10,
  totalCharge: Math.round(store.batches.reduce((acc, row) => acc + row.chargeKg, 0) * 10) / 10,
  totalOut: Math.round(store.batches.reduce((acc, row) => acc + row.outKg, 0) * 10) / 10,
  lowCount: store.lowRemainBatches.length,
  runningCount: store.furnaces.filter((row) => row.state === '运行').length,
  meltFurnaces: store.meltingFurnaces.length,
  annealFurnaces: store.annealingFurnaces.length,
  remeltedCount: store.batches.filter((row) => row.state === '已回炉').length,
}))

onMounted(() => {
  void store.loadAll()
})

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
  Object.assign(furnaceForm, {
    code: row.code,
    type: row.type,
    maxTempC: row.maxTempC,
    fuelType: row.fuelType,
    state: row.state,
  })
  furnaceDialog.value = true
}

async function submitFurnace(): Promise<void> {
  if (furnaceFormRef.value === undefined) return
  const valid = await furnaceFormRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingFurnaceId.value === null) {
      await store.createFurnace({ ...furnaceForm })
      ElMessage.success('窑炉已登记')
    } else {
      await store.updateFurnace(editingFurnaceId.value, { ...furnaceForm })
      ElMessage.success('窑炉信息已更新')
    }
    furnaceDialog.value = false
  } finally {
    submitting.value = false
  }
}

async function deleteFurnace(row: Furnace): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除「${row.code}」及其全部料液批次（技师取料道次保留用于对账），且不可恢复。`, '确认删除窑炉？', {
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

function openCreateBatch(): void {
  editingBatchId.value = null
  Object.assign(batchForm, {
    furnaceId: store.meltingFurnaces[0]?.id ?? store.furnaces[0]?.id ?? '',
    colorCode: '',
    recipe: '',
    meltDate: today(),
    tempC: 1150,
    chargeKg: 200,
    remainKg: 200,
    state: '在用',
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
    remainKg: row.remainKg,
    state: row.state,
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
      await store.createBatch({ ...batchForm })
      ElMessage.success('料液批次已登记（熔化车间账）')
    } else {
      await store.updateBatch(editingBatchId.value, { ...batchForm })
      ElMessage.success('熔化账已更新：配方/投料/余量已改，技师历史取料道次照旧保留')
    }
    batchDialog.value = false
  } finally {
    submitting.value = false
  }
}

async function deleteBatch(row: GlassBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除料液批次「${row.colorCode}」？技师已记的取料道次不会删除，对账时会列为无批次归属。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await store.deleteBatch(row.id)
  ElMessage.success('料液批次已删除，取料道次保留')
}

async function submitRefill(row: GlassBatch): Promise<void> {
  await store.refill(row.id, refillKg.value)
  ElMessage.success(`已补料 ${refillKg.value} kg（投料量与余量同步增加）`)
}

function openRemelt(row: GlassBatch): void {
  remeltTarget.value = row
  Object.assign(remeltForm, {
    colorCode: `${row.colorCode}-R`,
    recipe: row.recipe,
    meltDate: today(),
    tempC: row.tempC,
  })
  remeltDialog.value = true
}

async function submitRemelt(): Promise<void> {
  const target = remeltTarget.value
  if (target === null || remeltFormRef.value === undefined) return
  const valid = await remeltFormRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const created = await store.remelt(target.id, {
      furnaceId: target.furnaceId,
      ...remeltForm,
    })
    if (created !== null) {
      ElMessage.success(`已重熔为新批「${created.colorCode}」，转入余量 ${created.remainKg} kg`)
    }
    remeltDialog.value = false
  } finally {
    submitting.value = false
  }
}

function goDraws(): void {
  void router.push(ROUTES.draws)
}

function batchRowClass({ row }: { row: GlassBatch }): string {
  if (row.state === '已回炉') return 'row-remelted'
  return isLowRemain(row.remainKg) ? 'row-low-remain' : ''
}

function handleFurnaceFilter(key: string, value: string): void {
  if (key === 'type') store.setFilters({ type: value as FurnaceType | 'all' })
  if (key === 'state') store.setFilters({ state: value as FurnaceState | 'all' })
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="窑炉总数" :value="store.furnaces.length" suffix="台" tone="primary" icon="Histogram" />
      <StatBadge label="熔化/坩埚炉" :value="totals.meltFurnaces" suffix="台" tone="warning" icon="DataLine" />
      <StatBadge label="退火窑" :value="totals.annealFurnaces" suffix="台" tone="info" icon="Histogram" />
      <StatBadge label="运行中" :value="totals.runningCount" suffix="台" tone="success" icon="TrendCharts" />
      <StatBadge label="料液批次" :value="store.batches.length" suffix="批" tone="primary" icon="PieChart" />
      <StatBadge label="累计投料" :value="totals.totalCharge" suffix="kg" tone="info" icon="TrendCharts" />
      <StatBadge label="累计出料" :value="totals.totalOut" suffix="kg" tone="warning" icon="DataLine" />
      <StatBadge label="剩余总量" :value="totals.totalRemain" suffix="kg" tone="info" icon="TrendCharts" />
      <StatBadge
        label="低于补料阈值"
        :value="totals.lowCount"
        suffix="批"
        :tone="totals.lowCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        :hint="`剩余量低于 ${LOW_REMAIN_KG} kg 的在用批次数量`"
      />
    </div>

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
            {{ row.colorCode }}（{{ furnaceLabel[row.furnaceId] ?? '未知窑炉' }}）剩余
            <b>{{ row.remainKg }} kg</b> / 已出料 {{ row.outKg }} kg —— {{ row.recipe }}
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
        <el-table-column label="料液批次" width="110" align="right">
          <template #default="{ row }">{{ store.statOf(row.id).batchCount }} 批</template>
        </el-table-column>
        <el-table-column label="剩余合计" width="120" align="right">
          <template #default="{ row }">{{ store.statOf(row.id).totalRemainKg }} kg</template>
        </el-table-column>
        <el-table-column label="关联作品" width="110" align="right">
          <template #default="{ row }">{{ store.statOf(row.id).pieceCount }} 件</template>
        </el-table-column>
        <el-table-column label="低于阈值" width="110" align="right">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': store.statOf(row.id).lowCount > 0 }">
              {{ store.statOf(row.id).lowCount }} 批
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
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
          <span class="card-header__title">料液批次（熔化车间账：投料 · 配方 · 出料 · 余量）</span>
          <el-space wrap>
            <el-select v-model="selectedFurnaceId" style="width: 200px" size="small">
              <el-option value="all" label="全部窑炉" />
              <el-option
                v-for="item in store.furnaces"
                :key="item.id"
                :value="item.id"
                :label="`${item.code} · ${item.type}`"
              />
            </el-select>
            <el-button @click="goDraws">
              <el-icon><Document /></el-icon>
              <span>去技师取料台账</span>
            </el-button>
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
        description="熔化车间在批次上记投料量、配方与盘点余量；技师取料时由取料台账按当时余量原子扣减并累加出料量。"
        action-text="登记第一批料液"
        @action="openCreateBatch"
      />

      <el-table
        v-else
        v-loading="store.loading"
        :data="batches"
        row-key="id"
        stripe
        :row-class-name="batchRowClass"
      >
        <el-table-column label="色号 / 配方" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">
                {{ row.colorCode }}
                <el-tag v-if="row.state === '已回炉'" size="small" type="info">已回炉</el-tag>
                <el-tag v-else-if="row.remeltedFrom !== ''" size="small" type="warning">重熔批</el-tag>
              </span>
              <span class="cell-sub">{{ row.recipe }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所属窑炉" min-width="150">
          <template #default="{ row }">{{ furnaceLabel[row.furnaceId] ?? '（窑炉已删除）' }}</template>
        </el-table-column>
        <el-table-column prop="meltDate" label="熔化日期" width="110" />
        <el-table-column label="投料量" width="100" align="right">
          <template #default="{ row }">{{ row.chargeKg }} kg</template>
        </el-table-column>
        <el-table-column label="累计出料" width="100" align="right">
          <template #default="{ row }">
            <span class="cell-sub">{{ row.outKg }} kg</span>
          </template>
        </el-table-column>
        <el-table-column label="余量" width="120" align="right">
          <template #default="{ row }">
            <el-tag :type="row.state === '已回炉' ? 'info' : isLowRemain(row.remainKg) ? 'danger' : 'success'" size="small">
              {{ row.remainKg }} kg
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="补料" width="220">
          <template #default="{ row }">
            <el-space v-if="row.state === '在用'">
              <el-input-number v-model="refillKg" :min="1" :max="2000" :step="10" size="small" style="width: 110px" />
              <el-button size="small" @click="submitRefill(row)">补料</el-button>
            </el-space>
            <span v-else class="cell-sub">已封账</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEditBatch(row)">编辑/改配方</el-button>
            <el-button link type="warning" size="small" :disabled="row.state === '已回炉' || row.remainKg <= 0" @click="openRemelt(row)">
              回炉重熔
            </el-button>
            <el-button link type="danger" size="small" @click="deleteBatch(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
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

    <el-dialog v-model="batchDialog" :title="editingBatchId === null ? '登记料液批次（熔化车间账）' : '编辑料液批次 / 改配方'" width="640px">
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="130px">
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
          <el-input v-model="batchForm.recipe" type="textarea" :rows="2" placeholder="如：钠钙玻璃基础料 + 氧化钴 0.3%（改配方只改熔化账，技师历史取料道次保留）" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="出料温度（℃）" prop="tempC">
              <el-input-number v-model="batchForm.tempC" :min="600" :max="1800" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="投料量（kg）" prop="chargeKg">
              <el-input-number v-model="batchForm.chargeKg" :min="0" :max="5000" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="盘点余量（kg）" prop="remainKg">
              <el-input-number v-model="batchForm.remainKg" :min="0" :max="5000" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="editingBatchId !== null" label="批次状态">
          <el-radio-group v-model="batchForm.state">
            <el-radio value="在用">在用</el-radio>
            <el-radio value="已回炉">已回炉（封账）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="累计出料量由技师取料道次落账自动累加，熔化车间不手工登记出料。"
          description="改配方只更新熔化账这一本；技师已落账的取料道次照旧保留，对账时可看到取料当时的批次归属。"
        />
        <el-alert
          v-if="isLowRemain(batchForm.remainKg)"
          type="warning"
          show-icon
          :closable="false"
          class="mt-10"
          :title="`盘点余量低于补料阈值 ${LOW_REMAIN_KG} kg，保存后会在列表与顶部提醒中高亮。`"
        />
      </el-form>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="remeltDialog" title="回炉重熔" width="560px">
      <p v-if="remeltTarget" class="dialog-tip">
        旧批「<b>{{ remeltTarget.colorCode }}</b>」现存余量
        <b>{{ remeltTarget.remainKg }} kg</b> 将整锅转入新批；旧批随即封账（余量清零、状态置为已回炉）。
        技师那份取料道次照旧挂在旧批上，对账不受影响。
      </p>
      <el-form ref="remeltFormRef" :model="remeltForm" :rules="remeltRules" label-width="120px">
        <el-form-item label="新批色号" prop="colorCode">
          <el-input v-model="remeltForm.colorCode" placeholder="如：G-101-R" />
        </el-form-item>
        <el-form-item label="新批配方" prop="recipe">
          <el-input v-model="remeltForm.recipe" type="textarea" :rows="2" placeholder="重熔可同时改配方" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="重熔日期" prop="meltDate">
              <el-date-picker v-model="remeltForm.meltDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="出料温度（℃）">
              <el-input-number v-model="remeltForm.tempC" :min="600" :max="1800" :step="10" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="remeltDialog = false">取消</el-button>
        <el-button type="warning" :loading="submitting" @click="submitRemelt">确认回炉重熔</el-button>
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.low-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.dialog-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: #5b6b7a;
}

:deep(.row-low-remain) {
  background-color: #fef0f0;
}

:deep(.row-remelted) {
  background-color: #f4f4f5;
  color: #909399;
}

.mt-14 {
  margin-top: 14px;
}

.mt-10 {
  margin-top: 10px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
