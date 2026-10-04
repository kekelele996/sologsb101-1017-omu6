/**
 * 两本账对账工具：按料液批次核对熔化车间账与技师取料账。
 * - 熔化车间账：投料量 chargeKg、累计出料量 outKg、余量 remainKg
 * - 技师账：取料道次 draws 中「已落账」者按批次汇总
 * 两类差异：
 *   1. 出料差异 = 熔化侧累计出料量 outKg − 技师已落账取料量之和（扣穿/对不上主要看这项，标清差在哪批）
 *   2. 结存差异 = 投料量 − 累计出料量 − 余量（批次自身三本数不平，多见于手工改数/回炉转结）
 * 退回道次不计入取料量之和（本道未扣料），但单独列出便于技师重试。
 */
import type { GlassBatch } from '../types/batch'
import type { Furnace } from '../types/furnace'
import type { Piece } from '../types/piece'
import type { MaterialDraw } from '../types/draw'

/** 差异判读阈值（kg），低于视为浮点误差轧平 */
export const RECONCILE_EPSILON = 0.05

/** 批次对账行 */
export interface BatchReconcileRow {
  batch: GlassBatch
  furnaceCode: string
  /** 技师账：已落账取料量之和 */
  drawKg: number
  /** 已落账道次数 */
  drawCount: number
  /** 已退回道次数（未扣料，仅供重试，不参与轧差） */
  returnedCount: number
  /** 出料差异 = 熔化侧出料量 − 技师落账量（正数：熔化账多记出料/技师少记；负数：技师多记/批次被扣穿后无凭据） */
  outDiffKg: number
  /** 结存差异 = 投料量 − 出料量 − 余量 */
  stockDiffKg: number
  /** 本批是否轧平（两类差异都在阈值内） */
  balanced: boolean
  /** 差异说明（标清差在哪批、差多少、差在哪一侧） */
  issue: string
}

/** 汇总行（含无批次归属的孤儿道次） */
export interface ReconcileReport {
  rows: BatchReconcileRow[]
  /** 无批次归属或批次已删除的已落账道次 */
  orphanDraws: MaterialDraw[]
  /** 全部批次的已退回道次（跨批） */
  returnedDraws: MaterialDraw[]
  totals: {
    chargeKg: number
    outKg: number
    remainKg: number
    drawKg: number
    outDiffKg: number
    stockDiffKg: number
  }
  balancedCount: number
  diffCount: number
}

export function r1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 按料液批次生成对账报告 */
export function buildReconcileReport(
  batches: GlassBatch[],
  draws: MaterialDraw[],
  furnaces: Furnace[]
): ReconcileReport {
  const furnaceCode = new Map(furnaces.map((row) => [row.id, row.code]))
  const batchIds = new Set(batches.map((row) => row.id))

  const drawKgByBatch = new Map<string, number>()
  const drawCountByBatch = new Map<string, number>()
  const returnedCountByBatch = new Map<string, number>()
  const orphanDraws: MaterialDraw[] = []
  const returnedDraws: MaterialDraw[] = []

  draws.forEach((draw) => {
    if (draw.state === '已退回') {
      returnedDraws.push(draw)
      returnedCountByBatch.set(draw.batchId, (returnedCountByBatch.get(draw.batchId) ?? 0) + 1)
      return
    }
    if (draw.batchId === '' || !batchIds.has(draw.batchId)) {
      orphanDraws.push(draw)
      return
    }
    drawKgByBatch.set(draw.batchId, r1((drawKgByBatch.get(draw.batchId) ?? 0) + draw.kg))
    drawCountByBatch.set(draw.batchId, (drawCountByBatch.get(draw.batchId) ?? 0) + 1)
  })

  const rows: BatchReconcileRow[] = batches
    .slice()
    .sort((a, b) => b.meltDate.localeCompare(a.meltDate))
    .map((batch) => {
      const drawKg = r1(drawKgByBatch.get(batch.id) ?? 0)
      const outDiff = r1(batch.outKg - drawKg)
      const stockDiff = r1(batch.chargeKg - batch.outKg - batch.remainKg)
      const balanced =
        Math.abs(outDiff) <= RECONCILE_EPSILON && Math.abs(stockDiff) <= RECONCILE_EPSILON
      const issues: string[] = []
      if (Math.abs(outDiff) > RECONCILE_EPSILON) {
        if (outDiff > 0) {
          issues.push(
            `出料量对不上：熔化账累计出料 ${batch.outKg} kg，技师已落账取料合计 ${drawKg} kg，熔化侧多 ${outDiff} kg（技师侧少记 ${outDiff} kg）。`
          )
        } else {
          issues.push(
            `出料量对不上：熔化账累计出料 ${batch.outKg} kg，技师已落账取料合计 ${drawKg} kg，技师侧多 ${r1(-outDiff)} kg（批次余量曾被扣穿或熔化侧少记）。`
          )
        }
      }
      if (Math.abs(stockDiff) > RECONCILE_EPSILON) {
        if (stockDiff > 0) {
          issues.push(
            `批次结存不平：投料 ${batch.chargeKg} − 出料 ${batch.outKg} − 余量 ${batch.remainKg} = ${stockDiff} kg，账上少了 ${stockDiff} kg。`
          )
        } else {
          issues.push(
            `批次结存不平：投料 ${batch.chargeKg} − 出料 ${batch.outKg} − 余量 ${batch.remainKg} = ${stockDiff} kg，账上多出 ${r1(-stockDiff)} kg。`
          )
        }
      }
      if (batch.state === '已回炉') {
        issues.push('该批已回炉封账，现存余量已转入重熔新批；历史取料道次仍按本批对账。')
      }
      return {
        batch,
        furnaceCode: furnaceCode.get(batch.furnaceId) ?? '（窑炉已删除）',
        drawKg,
        drawCount: drawCountByBatch.get(batch.id) ?? 0,
        returnedCount: returnedCountByBatch.get(batch.id) ?? 0,
        outDiffKg: outDiff,
        stockDiffKg: stockDiff,
        balanced,
        issue: issues.join(' '),
      }
    })

  const sum = (list: number[]): number => r1(list.reduce((acc, value) => acc + value, 0))
  const totals = {
    chargeKg: sum(batches.map((row) => row.chargeKg)),
    outKg: sum(batches.map((row) => row.outKg)),
    remainKg: sum(batches.map((row) => row.remainKg)),
    drawKg: sum(rows.map((row) => row.drawKg)),
    outDiffKg: sum(rows.map((row) => row.outDiffKg)),
    stockDiffKg: sum(rows.map((row) => row.stockDiffKg)),
  }

  return {
    rows,
    orphanDraws,
    returnedDraws,
    totals,
    balancedCount: rows.filter((row) => row.balanced).length,
    diffCount: rows.filter((row) => !row.balanced).length,
  }
}

/** 取料道次显示用的作品名（作品已删除时兜底） */
export function pieceNameOf(pieces: Piece[], pieceId: string): string {
  return pieces.find((row) => row.id === pieceId)?.name ?? '（作品已删除）'
}
