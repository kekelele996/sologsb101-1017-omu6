<script setup lang="ts">
/**
 * /reconcile 两本账对账（按料液批次）
 * 熔化车间账（投料 / 累计出料 / 余量）与技师账（取料道次已落账合计）逐批核对：
 * - 出料差异 = 批次累计出料量 − 技师已落账取料量之和（标清差在哪批、差在哪侧）
 * - 结存差异 = 投料量 − 累计出料量 − 余量
 * 退回道次未扣料，不参与轧差，单独列出供本侧重试；无批次归属的孤儿道次单独列出。
 * 批次回炉重熔 / 改配方后，历史道次仍按原批次对账。
 * 消费模型：GlassBatch、MaterialDraw、Piece、Furnace；复用组件：<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import StatBadge from '@/components/common/StatBadge.vue'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { useDrawStore } from '@/stores/drawStore'
import { buildReconcileReport, pieceNameOf } from '@/utils/reconcile'
import { exportReconcileCsvFile } from '@/utils/export'
import type { MaterialDraw } from '@/types/draw'

const furnaceStore = useFurnaceStore()
const pieceStore = usePieceStore()
const drawStore = useDrawStore()

const onlyDiff = ref(false)

onMounted(() => {
  void furnaceStore.loadAll()
  void pieceStore.loadAll()
  void drawStore.loadAll()
})

const report = computed(() =>
  buildReconcileReport(furnaceStore.batches, drawStore.draws, furnaceStore.furnaces)
)

const shownRows = computed(() => (onlyDiff.value ? report.value.rows.filter((row) => !row.balanced) : report.value.rows))

const batchColorCode = computed<Record<string, string>>(() =>
  Object.fromEntries(furnaceStore.batches.map((row) => [row.id, row.colorCode]))
)

async function retryDraw(row: MaterialDraw): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `只按技师本侧重试「${pieceNameOf(pieceStore.pieces, row.pieceId)}」第 ${row.drawSeq} 道（${row.kg} kg），沿用原批次再扣一次余量；熔化侧不做任何补偿。`,
      '本侧重试确认',
      { type: 'warning', confirmButtonText: '按原参数重试', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await drawStore.retry(row.id)
  if (result.ok) {
    ElMessage.success(`重试成功，批次余量 ${result.remainKg} kg`)
  } else {
    ElMessageBox.alert(result.reason, '重试仍被退回', { type: 'warning' }).catch(() => undefined)
  }
}

function exportCsv(): void {
  const filename = exportReconcileCsvFile(report.value)
  ElMessage.success(`已导出对账单 ${filename}`)
}

function diffClass({ row }: { row: (typeof report.value.rows)[number] }): string {
  return row.balanced ? '' : 'row-diff'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="批次总数" :value="report.rows.length" suffix="批" tone="primary" icon="PieChart" />
      <StatBadge label="轧平" :value="report.balancedCount" suffix="批" tone="success" icon="DataLine" />
      <StatBadge
        label="对不上"
        :value="report.diffCount"
        suffix="批"
        :tone="report.diffCount > 0 ? 'danger' : 'success'"
        icon="Warning"
      />
      <StatBadge label="累计投料" :value="report.totals.chargeKg" suffix="kg" tone="info" icon="TrendCharts" />
      <StatBadge label="熔化账出料" :value="report.totals.outKg" suffix="kg" tone="warning" icon="DataLine" />
      <StatBadge label="技师账取料" :value="report.totals.drawKg" suffix="kg" tone="primary" icon="Histogram" />
      <StatBadge
        label="出料差异合计"
        :value="report.totals.outDiffKg"
        suffix="kg"
        :tone="Math.abs(report.totals.outDiffKg) > 0.05 ? 'danger' : 'success'"
        icon="Warning"
      />
      <StatBadge label="现存余量" :value="report.totals.remainKg" suffix="kg" tone="info" icon="TrendCharts" />
    </div>

    <el-alert
      v-if="report.diffCount > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${report.diffCount} 批料液两本账对不上，已在下表标清差在哪批、差多少、差在哪侧。`"
    >
      <template #default>
        <div class="diff-list">
          <div v-for="row in report.rows.filter((item) => !item.balanced)" :key="row.batch.id">
            <b>{{ row.batch.colorCode }}</b>（{{ row.furnaceCode }}）：{{ row.issue }}
          </div>
        </div>
      </template>
    </el-alert>
    <el-alert v-else type="success" show-icon :closable="false" class="mb-14" title="全部批次两本账轧平：累计出料量 = 技师已落账取料量之和。" />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">按料液批次对账</span>
          <el-space wrap>
            <el-checkbox v-model="onlyDiff">只看对不上的批次</el-checkbox>
            <el-button @click="exportCsv">
              <el-icon><Download /></el-icon>
              <span>导出对账单 CSV</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <el-table :data="shownRows" row-key="batch.id" stripe :row-class-name="diffClass">
        <el-table-column label="色号 / 配方" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">
                {{ row.batch.colorCode }}
                <el-tag v-if="row.batch.state === '已回炉'" size="small" type="info">已回炉</el-tag>
                <el-tag v-else-if="row.batch.remeltedFrom !== ''" size="small" type="warning">重熔批</el-tag>
              </span>
              <span class="cell-sub">{{ row.batch.recipe }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所属窑炉" width="130">
          <template #default="{ row }">{{ row.furnaceCode }}</template>
        </el-table-column>
        <el-table-column label="熔化账投料" width="110" align="right">
          <template #default="{ row }">{{ row.batch.chargeKg }} kg</template>
        </el-table-column>
        <el-table-column label="熔化账出料" width="110" align="right">
          <template #default="{ row }">{{ row.batch.outKg }} kg</template>
        </el-table-column>
        <el-table-column label="技师落账取料" width="120" align="right">
          <template #default="{ row }">
            <b>{{ row.drawKg }} kg</b>
            <span class="cell-sub"> / {{ row.drawCount }} 道</span>
          </template>
        </el-table-column>
        <el-table-column label="余量" width="100" align="right">
          <template #default="{ row }">{{ row.batch.remainKg }} kg</template>
        </el-table-column>
        <el-table-column label="出料差异" width="120" align="right">
          <template #default="{ row }">
            <el-tag size="small" :type="Math.abs(row.outDiffKg) > 0.05 ? 'danger' : 'success'">
              {{ row.outDiffKg > 0 ? '+' : '' }}{{ row.outDiffKg }} kg
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结存差异" width="120" align="right">
          <template #default="{ row }">
            <el-tag size="small" :type="Math.abs(row.stockDiffKg) > 0.05 ? 'danger' : 'success'">
              {{ row.stockDiffKg > 0 ? '+' : '' }}{{ row.stockDiffKg }} kg
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结论 / 退回" min-width="260">
          <template #default="{ row }">
            <div class="cell-stack">
              <span :class="row.balanced ? 'cell-ok' : 'cell-warn'">
                {{ row.balanced ? '轧平' : row.issue }}
              </span>
              <el-button v-if="row.returnedCount > 0" link type="warning" size="small" @click="onlyDiff = true">
                {{ row.returnedCount }} 道退回未扣料，可重试
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="report.returnedDraws.length > 0" shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">已退回道次（未扣料，只按技师本侧重试，熔化侧不动）</span>
      </template>
      <el-table :data="report.returnedDraws" row-key="id" stripe>
        <el-table-column label="作品 / 道次" min-width="180">
          <template #default="{ row }">
            {{ pieceNameOf(pieceStore.pieces, row.pieceId) }} · 第 {{ row.drawSeq }} 道
          </template>
        </el-table-column>
        <el-table-column label="批次" width="130">
          <template #default="{ row }">{{ batchColorCode[row.batchId] ?? '（批次已删除）' }}</template>
        </el-table-column>
        <el-table-column label="申请取量" width="100" align="right">
          <template #default="{ row }">{{ row.kg }} kg</template>
        </el-table-column>
        <el-table-column prop="operator" label="操作人" width="90" />
        <el-table-column label="退回原因" min-width="300">
          <template #default="{ row }"><span class="cell-warn">{{ row.rejectReason }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="warning" size="small" @click="retryDraw(row)">本侧重试</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="report.orphanDraws.length > 0" shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">无批次归属的已落账道次（批次被删除，取料量无批可对）</span>
      </template>
      <el-table :data="report.orphanDraws" row-key="id" stripe>
        <el-table-column label="作品" min-width="180">
          <template #default="{ row }">{{ pieceNameOf(pieceStore.pieces, row.pieceId) }}</template>
        </el-table-column>
        <el-table-column label="第几道" width="90" align="right">
          <template #default="{ row }">第 {{ row.drawSeq }} 道</template>
        </el-table-column>
        <el-table-column label="取料量" width="100" align="right">
          <template #default="{ row }">{{ row.kg }} kg</template>
        </el-table-column>
        <el-table-column prop="operator" label="操作人" width="100" />
        <el-table-column prop="drawnAt" label="取料时间" min-width="160">
          <template #default="{ row }">{{ row.drawnAt.replace('T', ' ') }}</template>
        </el-table-column>
      </el-table>
    </el-card>
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  font-size: 12px;
  color: #c0392b;
}

.cell-ok {
  font-size: 12px;
  color: #2e7d32;
}

.diff-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

:deep(.row-diff) {
  background-color: #fef0f0;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
