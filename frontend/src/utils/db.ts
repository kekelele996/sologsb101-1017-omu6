/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑：
 *   v1 → v2：为 Piece 增加 craft 索引并回填默认值；
 *   v2 → v3：两本账改造——熔化车间批次补「投料量 / 出料量 / 乐观锁版本」，
 *            新增 draws 技师取料道次表；旧「取料」工序按作品挂的批次回填（缺批次/缺用量一并补齐）。
 * - 取料落账在单个 Dexie 事务内完成「重读批次 → 按当时余量判定 → 扣批次 / 写取料道次」，
 *   两个终端同时保存时，晚到的一次只退回技师这一条（余量不足），批次与别人的取料记录不动。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { Draw, DrawDraft, DrawPostResult, DrawRejectReason, DrawState } from '../types/draw'
import { nowIso, uuid } from './id'
import { round1 } from './thermal'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** 迁移回填时无法从备注解析出用量的默认取料量（kg），对账时会以差异形式标出 */
export const MIGRATION_FALLBACK_DRAW_KG = 0

/** 从「取 G-101 料液约 6.2 kg」一类备注中解析用量（kg） */
export function parseDrawKgFromRemark(remark: string): number | null {
  if (typeof remark !== 'string' || remark === '') return null
  const matched = remark.match(/([0-9]+(?:\.[0-9]+)?)\s*kg/i)
  if (matched === null) return null
  const value = Number(matched[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>
  /** 技师那本账：每件作品的取料道次 */
  draws!: Table<Draw, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：两本账（熔化车间批次台账 + 技师取料道次台账） ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        // 新增 chargeKg 投料量 / outKg 出料量 / version 乐观锁版本 / cycle 熔炼轮次
        batches: 'id, furnaceId, colorCode, meltDate, remainKg, outKg, version, cycle',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
        // 技师账：[pieceId+seq] 保证一件作品每个取料道次只有一条；batchId / state 供对账与筛选
        draws: 'id, pieceId, [pieceId+seq], batchId, state, seq, stepId',
      })
      .upgrade(async (tx) => {
        // 迁移 A：批次按熔化车间账补齐投料量 / 出料量 / 熔炼轮次 / 乐观锁版本。
        // 历史数据只有余量：视为该批尚未在本台账内出料（outKg = 0），
        // 投料量按「当时余量」承接，两本账是否对得上交由对账页按批次标差，不篡改旧账。
        await tx.table('batches').toCollection().modify((row: Record<string, unknown>) => {
          const remain = typeof row.remainKg === 'number' && Number.isFinite(row.remainKg) ? row.remainKg : 0
          row.chargeKg = typeof row.chargeKg === 'number' ? row.chargeKg : remain
          row.outKg = typeof row.outKg === 'number' ? row.outKg : 0
          row.cycle = typeof row.cycle === 'number' ? row.cycle : 1
          row.version = typeof row.version === 'number' ? row.version : 1
          row.migrated = true
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })

        // 迁移 B：旧数据按归属迁移——技师那本账的取料道次从历史「取料」工序生成。
        // 缺批次和用量的取料道次，批次按作品挂的 batchId 回填，用量从备注解析（解析不到记 0 并标 migrated）。
        const [pieceRows, batchRows, stepRows] = await Promise.all([
          tx.table('pieces').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('batches').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('steps').toArray() as Promise<Array<Record<string, unknown>>>,
        ])
        const pieceById = new Map<string, Record<string, unknown>>(pieceRows.map((row) => [String(row.id), row]))
        const batchById = new Map<string, Record<string, unknown>>(batchRows.map((row) => [String(row.id), row]))
        const takeSteps = stepRows.filter((row) => row.name === '取料')

        for (const step of takeSteps) {
          const pieceId = String(step.pieceId ?? '')
          const piece = pieceById.get(pieceId)
          const batchId = piece && typeof piece.batchId === 'string' ? piece.batchId : ''
          const batch = batchById.has(batchId) ? batchById.get(batchId) : undefined
          const parsedKg = parseDrawKgFromRemark(typeof step.remark === 'string' ? step.remark : '')
          const drawKg = parsedKg ?? MIGRATION_FALLBACK_DRAW_KG
          const stamp = nowIso()
          const draw: Record<string, unknown> = {
            // 确定性 id：同一库重复执行升级也不会产生重复行
            id: `draw-mig-${String(step.id)}`,
            pieceId,
            pieceName: piece && typeof piece.name === 'string' ? piece.name : '（作品已删除）',
            seq: typeof step.seq === 'number' ? step.seq : 1,
            stepId: String(step.id ?? ''),
            batchId,
            batchColorCode: batch && typeof batch.colorCode === 'string' ? batch.colorCode : '（批次缺失）',
            batchRecipe: batch && typeof batch.recipe === 'string' ? batch.recipe : '',
            batchCycle: batch && typeof batch.cycle === 'number' ? batch.cycle : 1,
            drawKg,
            operator: typeof step.operator === 'string' ? step.operator : '',
            state: '已落账',
            rejectReason: '',
            remainAtReject: 0,
            seenVersion: batch && typeof batch.version === 'number' ? batch.version : 1,
            attempts: 1,
            migrated: true,
            createdAt: typeof step.createdAt === 'string' ? step.createdAt : stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }
          await tx.table('draws').put(draw)
        }
      })
  }
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次（技师取料道次保留，按「批次缺失」单列对账） */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------------ 料液批次（熔化车间账） ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 删除批次：技师那本账的取料道次照旧保留（批次回炉重熔 / 改配方 / 删除都不动技师账），
 * 对账时以「批次缺失」单列标出。
 */
export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/**
 * 改配方：只改熔化车间侧配方并把乐观锁版本 +1。
 * 技师已落账取料道次里的配方快照完全不动。
 */
export async function changeBatchRecipe(batchId: string, recipe: string): Promise<GlassBatch | null> {
  return db.transaction('rw', db.batches, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch) return null
    const next: GlassBatch = {
      ...batch,
      recipe: recipe.trim() || batch.recipe,
      version: batch.version + 1,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    }
    await db.batches.put(next)
    return next
  })
}

/**
 * 回炉重熔：开新一轮熔炼，投料量重新计、出料量清零、余量恢复为新投料量。
 * 熔炼轮次 +1、乐观锁版本 +1；技师账旧轮次的取料道次照旧保留（带旧轮次快照）。
 */
export async function remeltBatch(
  batchId: string,
  payload: { recipe: string; chargeKg: number; meltDate: string; tempC: number },
): Promise<GlassBatch | null> {
  return db.transaction('rw', db.batches, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch) return null
    const chargeKg = round1(Math.max(0, payload.chargeKg))
    const next: GlassBatch = {
      ...batch,
      recipe: payload.recipe.trim() || batch.recipe,
      meltDate: payload.meltDate || batch.meltDate,
      tempC: payload.tempC,
      chargeKg,
      outKg: 0,
      remainKg: chargeKg,
      cycle: batch.cycle + 1,
      version: batch.version + 1,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    }
    await db.batches.put(next)
    return next
  })
}

/**
 * 补料：熔化车间侧追加投料量（投料量与余量同时增加，出料量不动）。
 * 不改变乐观锁版本：补料不影响正在排队的取料判定。
 */
export async function refillBatch(batchId: string, kg: number): Promise<GlassBatch | null> {
  return db.transaction('rw', db.batches, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch) return null
    const add = round1(Math.max(0, kg))
    const next: GlassBatch = {
      ...batch,
      chargeKg: round1(batch.chargeKg + add),
      remainKg: round1(batch.remainKg + add),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    }
    await db.batches.put(next)
    return next
  })
}

/* ------------------------------ 取料道次（技师账） ------------------------------ */

export async function listDraws(): Promise<Draw[]> {
  const rows = await db.draws.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listDrawsByPiece(pieceId: string): Promise<Draw[]> {
  const rows = await db.draws.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq || b.updatedAt.localeCompare(a.updatedAt))
}

function buildRejectedDraw(
  draft: DrawDraft,
  stateData: {
    batchId: string
    colorCode: string
    recipe: string
    cycle: number
    version: number
    remainKg: number
    reason: DrawRejectReason
  },
  stamp: string,
  attempts: number,
  existing: Draw | null,
): Draw {
  const messageRemain = stateData.remainKg
  return {
    id: existing?.id ?? uuid('draw'),
    pieceId: draft.pieceId,
    pieceName: existing?.pieceName ?? draft.pieceId,
    seq: draft.seq,
    stepId: draft.stepId,
    batchId: stateData.batchId,
    batchColorCode: stateData.colorCode,
    batchRecipe: stateData.recipe,
    batchCycle: stateData.cycle,
    drawKg: round1(Math.max(0, draft.drawKg)),
    operator: draft.operator.trim() || existing?.operator || '',
    state: '已退回' as DrawState,
    rejectReason: stateData.reason,
    remainAtReject: round1(messageRemain),
    seenVersion: stateData.version,
    attempts,
    migrated: false,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }
}

/**
 * 技师落账一笔取料道次（首次登记与本侧重试共用同一套判定）：
 * 1. 单个 rw 事务内重读批次「当时余量」——两个终端同时保存时，先提交者已扣减，
 *    晚到者在这里读到的是新余量，从源头杜绝「扣穿」；
 * 2. 批次不存在或余量不足（remainKg < drawKg）→ 整笔回滚（批次与别人的取料记录不动），
 *    随后在独立事务里只把技师这一条写成「已退回」并写明余量不足；
 * 3. 余量充足 → 同事务扣批次出料量 / 余量、version+1，并写「已落账」取料道次。
 */
export async function postDraw(draft: DrawDraft, existing: Draw | null = null): Promise<DrawPostResult> {
  const drawKg = round1(Math.max(0, draft.drawKg))
  const attempts = (existing?.attempts ?? 0) + 1

  // ---------- 尝试落账（可能因余量不足整笔回滚） ----------
  const committed = await db.transaction('rw', db.batches, db.pieces, db.draws, async () => {
    const batch = await db.batches.get(draft.batchId)
    const piece = await db.pieces.get(draft.pieceId)
    const stamp = nowIso()

    // 道次唯一（DB 层兜底，UI 层已先行提示）：一件作品的同一个取料道次只记一条（重试自身除外）
    const sameSeq = await db.draws.where({ pieceId: draft.pieceId, seq: draft.seq }).first()
    if (sameSeq && sameSeq.id !== existing?.id) {
      throw new Error(`第 ${draft.seq} 取料道次已记账（${sameSeq.state} ${sameSeq.drawKg} kg），一道次只记一条`)
    }

    if (!batch) {
      // 批次已被删除 / 回炉后换批：不扣任何东西，交由外层只退回技师这一条
      const rejected = buildRejectedDraw(
        draft,
        {
          batchId: draft.batchId,
          colorCode: existing?.batchColorCode ?? '（批次缺失）',
          recipe: existing?.batchRecipe ?? '',
          cycle: existing?.batchCycle ?? 1,
          version: existing?.seenVersion ?? 1,
          remainKg: existing?.remainAtReject ?? 0,
          reason: '批次不存在',
        },
        stamp,
        attempts,
        existing,
      )
      return { status: 'reject' as const, rejected, pieceName: piece?.name ?? existing?.pieceName ?? '' }
    }

    if (batch.remainKg + 1e-6 < drawKg) {
      // 晚到的那次：别人取走的不动，只退回本条，写明余量不足及当时余量
      const rejected = buildRejectedDraw(
        draft,
        {
          batchId: batch.id,
          colorCode: batch.colorCode,
          recipe: batch.recipe,
          cycle: batch.cycle,
          version: batch.version,
          remainKg: batch.remainKg,
          reason: '余量不足',
        },
        stamp,
        attempts,
        existing,
      )
      return { status: 'reject' as const, rejected, pieceName: piece?.name ?? existing?.pieceName ?? '' }
    }

    const nextBatch: GlassBatch = {
      ...batch,
      outKg: round1(batch.outKg + drawKg),
      remainKg: round1(batch.remainKg - drawKg),
      version: batch.version + 1,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.batches.put(nextBatch)

    const draw: Draw = {
      id: existing?.id ?? uuid('draw'),
      pieceId: draft.pieceId,
      pieceName: piece?.name ?? existing?.pieceName ?? draft.pieceId,
      seq: draft.seq,
      stepId: draft.stepId,
      batchId: batch.id,
      batchColorCode: batch.colorCode,
      batchRecipe: batch.recipe,
      batchCycle: batch.cycle,
      drawKg,
      operator: draft.operator.trim() || existing?.operator || '',
      state: '已落账',
      rejectReason: '',
      remainAtReject: nextBatch.remainKg,
      seenVersion: nextBatch.version,
      attempts,
      migrated: false,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.draws.put(draw)
    return { status: 'ok' as const, draw, remainKg: nextBatch.remainKg }
  })

  // ---------- 落账成功 ----------
  if (committed.status === 'ok') {
    return {
      ok: true,
      draw: committed.draw,
      remainKg: committed.remainKg,
      message:
        attempts > 1
          ? `第 ${committed.draw.seq} 道取料重试落账成功：${committed.draw.batchColorCode} ${drawKg} kg，批次余量 ${committed.remainKg} kg`
          : `第 ${committed.draw.seq} 道取料已落账：${committed.draw.batchColorCode} ${drawKg} kg，批次余量 ${committed.remainKg} kg`,
    }
  }

  // ---------- 落账失败：独立事务只写技师这一条退回记录（另一边不动） ----------
  const rejectedRow = await db.transaction('rw', db.draws, async () => {
    const pieceName = committed.pieceName
    const row: Draw = { ...committed.rejected, pieceName: pieceName || committed.rejected.pieceName }
    await db.draws.put(row)
    return row
  })

  const message =
    rejectedRow.rejectReason === '批次不存在'
      ? `第 ${rejectedRow.seq} 道取料已退回：批次「${rejectedRow.batchColorCode}」不存在（可能已删除或换批），本次没有扣任何料；请改用有效批次后在技师侧重试`
      : `第 ${rejectedRow.seq} 道取料已退回：${rejectedRow.batchColorCode} 当时余量仅 ${rejectedRow.remainAtReject} kg，不足 ${drawKg} kg（可能他人先取走）；别人的取料与批次余量未改动，可在余量补足后于技师侧重试本条`

  return { ok: false, draw: rejectedRow, remainKg: rejectedRow.remainAtReject, message }
}

/** 技师侧删除自己这一侧的取料道次（仅退回中的记录允许删；已落账记录是两边对账依据，不允许删） */
export async function removeDraw(id: string): Promise<void> {
  await db.draws.delete(id)
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火、检验与该作品的技师取料道次 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, db.draws, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.draws.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
  draws: Draw[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects, draws] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.draws.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    anneals,
    inspects,
    draws,
  }
}

const ALL_TABLES = [
  db.furnaces,
  db.batches,
  db.pieces,
  db.steps,
  db.anneals,
  db.inspects,
  db.draws,
] as const

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
      db.draws.clear(),
    ])
    await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
    // 兼容旧版（v2）存档：没有 draws 数组时导入为空
    if (Array.isArray(snapshot.draws)) {
      await db.draws.bulkPut(snapshot.draws.map((row) => ({ ...row, revision: ROW_REVISION })))
    }
  })
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
      db.draws.clear(),
    ])
  })
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects, draws] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
    db.draws.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects, draws }
}
