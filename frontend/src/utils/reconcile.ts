/**
 * 两本账对账（纯函数）
 * 熔化车间账（GlassBatch：投料量 / 出料量 / 余量）与技师账（Draw：每道取料）
 * 按料液批次对账：
 *   1) 技师「已落账」取料量之和 应等于 批次「出料量」；
 *   2) 批次「投料量 - 出料量」应等于批次「余量」；
 *   3) 技师账里引用了已删除批次的取料道次，单列为「批次缺失」。
 * 任一处对不上即标记有差，并写清差在哪批、差多少。
 */
import type { GlassBatch } from '../types/batch'
import type { Draw } from '../types/draw'

/** 重量比对容差（kg），规避 0.1 步长浮点误差 */
export const WEIGHT_EPS = 0.05

/** 差额方向 */
export type DiffSide = 'none' | 'melt' | 'tech' | 'both'

export interface BatchReconcileRow {
  batchId: string
  colorCode: string
  recipe: string
  cycle: number
  /** 熔化车间账：投料量 */
  chargeKg: number
  /** 熔化车间账：出料量 */
  outKg: number
  /** 熔化车间账：余量 */
  remainKg: number
  /** 技师账：当前轮次已落账取料量之和（与出料量对账的口径） */
  techDrawKg: number
  /** 技师账：当前轮次已落账取料道次数 */
  techDrawCount: number
  /** 技师账：历史轮次（回炉重熔前）已落账取料量之和，照旧保留、不参与本轮出料对账 */
  techHistoryKg: number
  /** 技师账：历史轮次取料道次数 */
  techHistoryCount: number
  /** 技师账：被退回（未落账）的取料道次数 */
  rejectedCount: number
  /** 技师账取料合计 - 车间出料量；正数 = 技师账多，负数 = 车间账多 */
  ledgerDiffKg: number
  /** （投料 - 出料）- 余量；正数表示余量记得偏少 */
  remainDiffKg: number
  /** 该批是否对平 */
  balanced: boolean
  /** 差在哪一侧 */
  diffSide: DiffSide
  /** 给排产员看的逐条说明 */
  issues: string[]
  /** 是否为迁移回填数据（差异可能来自历史口径） */
  migrated: boolean
}

/** 技师账引用了已不存在批次的取料道次 */
export interface OrphanDrawGroup {
  batchId: string
  count: number
  totalKg: number
  draws: Draw[]
}

export interface ReconcileReport {
  rows: BatchReconcileRow[]
  orphans: OrphanDrawGroup[]
  balancedCount: number
  diffCount: number
  orphanCount: number
  totalLedgerDiffKg: number
  totalRemainDiffKg: number
  balanced: boolean
}

function sameWeight(a: number, b: number): boolean {
  return Math.abs(a - b) <= WEIGHT_EPS
}

/** 按料液批次对账 */
export function reconcileLedgers(batches: GlassBatch[], draws: Draw[]): ReconcileReport {
  const posted = draws.filter((row) => row.state === '已落账')
  const rejected = draws.filter((row) => row.state === '已退回')

  const rejectedCountByBatch = new Map<string, number>()

  rejected.forEach((row) => {
    rejectedCountByBatch.set(row.batchId, (rejectedCountByBatch.get(row.batchId) ?? 0) + 1)
  })

  const batchIds = new Set<string>(batches.map((row) => row.id))

  const rows: BatchReconcileRow[] = batches
    .slice()
    .sort((a, b) => b.meltDate.localeCompare(a.meltDate))
    .map((batch) => {
      // 当前轮次的技师取料与本轮出料量对账；回炉重熔前的历史轮次取料照旧保留，单列不判差
      const currentPosted = posted.filter((row) => row.batchId === batch.id && row.batchCycle === batch.cycle)
      const historyPosted = posted.filter((row) => row.batchId === batch.id && row.batchCycle < batch.cycle)
      const techDrawKg = Math.round(currentPosted.reduce((acc, row) => acc + row.drawKg, 0) * 100) / 100
      const techHistoryKg = Math.round(historyPosted.reduce((acc, row) => acc + row.drawKg, 0) * 100) / 100
      const ledgerDiffKg = Math.round((techDrawKg - batch.outKg) * 100) / 100
      const remainDiffKg = Math.round((batch.chargeKg - batch.outKg - batch.remainKg) * 100) / 100

      const ledgerBalanced = sameWeight(techDrawKg, batch.outKg)
      const remainBalanced = sameWeight(batch.chargeKg - batch.outKg, batch.remainKg)
      const balanced = ledgerBalanced && remainBalanced

      const issues: string[] = []
      if (!ledgerBalanced) {
        const sign = ledgerDiffKg > 0 ? '多记' : '少记'
        issues.push(
          `取料账不平：技师第 ${batch.cycle} 轮已落账取料合计 ${techDrawKg} kg，熔化车间出料量 ${batch.outKg} kg，` +
            `技师账${sign} ${Math.abs(ledgerDiffKg)} kg`,
        )
      }
      if (!remainBalanced) {
        issues.push(
          `余量对不上：投料 ${batch.chargeKg} - 出料 ${batch.outKg} 应为 ${
            Math.round((batch.chargeKg - batch.outKg) * 100) / 100
          } kg，批次余量记为 ${batch.remainKg} kg，相差 ${Math.abs(remainDiffKg)} kg`,
        )
      }
      const rejectedCount = rejectedCountByBatch.get(batch.id) ?? 0
      if (rejectedCount > 0) {
        issues.push(`有 ${rejectedCount} 道取料因余量不足 / 批次状态变化被退回，未计入出料量，可在技师侧重试`)
      }

      const diffSide: DiffSide =
        balanced ? 'none' : !ledgerBalanced && !remainBalanced ? 'both' : !ledgerBalanced ? 'tech' : 'melt'

      return {
        batchId: batch.id,
        colorCode: batch.colorCode,
        recipe: batch.recipe,
        cycle: batch.cycle,
        chargeKg: batch.chargeKg,
        outKg: batch.outKg,
        remainKg: batch.remainKg,
        techDrawKg,
        techDrawCount: currentPosted.length,
        techHistoryKg,
        techHistoryCount: historyPosted.length,
        rejectedCount,
        ledgerDiffKg,
        remainDiffKg,
        balanced,
        diffSide,
        issues,
        migrated: batch.migrated === true,
      }
    })

  // 技师账引用了已删除 / 不存在批次
  const orphanMap = new Map<string, Draw[]>()
  draws.forEach((row) => {
    if (!batchIds.has(row.batchId)) {
      const list = orphanMap.get(row.batchId) ?? []
      list.push(row)
      orphanMap.set(row.batchId, list)
    }
  })
  const orphans: OrphanDrawGroup[] = Array.from(orphanMap.entries()).map(([batchId, list]) => ({
    batchId,
    count: list.length,
    totalKg: Math.round(list.reduce((acc, row) => acc + (row.state === '已落账' ? row.drawKg : 0), 0) * 100) / 100,
    draws: list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }))

  const diffCount = rows.filter((row) => !row.balanced).length
  const totalLedgerDiffKg = Math.round(rows.reduce((acc, row) => acc + Math.abs(row.ledgerDiffKg), 0) * 100) / 100
  const totalRemainDiffKg = Math.round(rows.reduce((acc, row) => acc + Math.abs(row.remainDiffKg), 0) * 100) / 100

  return {
    rows,
    orphans,
    balancedCount: rows.length - diffCount,
    diffCount,
    orphanCount: orphans.reduce((acc, group) => acc + group.count, 0),
    totalLedgerDiffKg,
    totalRemainDiffKg,
    balanced: diffCount === 0 && orphans.length === 0,
  }
}
