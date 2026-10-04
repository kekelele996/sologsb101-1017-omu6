/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑
 *   v1 → v2：为 Piece 增加 craft 索引并回填默认值
 *   v2 → v3：两本账分立——熔化车间在 batches 上记投料量/出料量/配方/余量，
 *            技师在 draws（取料道次）上记用哪批料、取多少、操作人；
 *            旧版「取料」工序按归属迁移为取料道次（缺批次按作品挂的批次回填，
 *            缺用量按备注约数回填、再缺用默认值），批次出料量按迁移道次回填使旧账轧平。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch, GlassBatchDraft } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { MaterialDraw, MaterialDrawDraft } from '../types/draw'
import { nowIso, uuid } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** 旧数据迁移时取料道次缺用量的回填默认值（kg） */
export const MIGRATE_DEFAULT_DRAW_KG = 2.5

/** 从旧版工序备注里解析「约 6.2 kg」这类用量约数 */
const REMARK_KG_PATTERN = /([\d]+(?:\.\d+)?)\s*kg/i

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>
  /** 技师账：取料道次 */
  draws!: Table<MaterialDraw, string>

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

    // ---------- v3：熔化车间账 / 技师账分立，新增 draws（取料道次） ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        // chargeKg 投料量、outKg 累计出料量、state 在用/已回炉、remeltedFrom 回炉来源
        batches: 'id, furnaceId, colorCode, meltDate, remainKg, state, remeltedFrom',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
        // 技师账：作品 + 道次序号复合索引，便于按作品对账与排重
        draws: 'id, pieceId, batchId, state, [pieceId+drawSeq], stepId',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso()
        const [pieceRows, batchRows, stepRows] = await Promise.all([
          tx.table('pieces').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('batches').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('steps').toArray() as Promise<Array<Record<string, unknown>>>,
        ])
        const pieceBatch = new Map<string, string>(
          pieceRows.map((row) => [String(row.id), typeof row.batchId === 'string' ? row.batchId : ''])
        )
        const batchIds = new Set(batchRows.map((row) => String(row.id)))

        // 迁移 6：旧版「取料」工序按归属迁移为技师取料道次。
        // 缺批次 → 按作品挂的批次回填；缺用量 → 先按备注约数解析，再缺用默认值回填。
        const seqByPiece = new Map<string, number>()
        const drawsToAdd: MaterialDraw[] = []
        stepRows
          .filter((row) => row.name === '取料')
          .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
          .forEach((step) => {
            const pieceId = String(step.pieceId ?? '')
            const nextSeq = (seqByPiece.get(pieceId) ?? 0) + 1
            seqByPiece.set(pieceId, nextSeq)
            const remark = typeof step.remark === 'string' ? step.remark : ''
            const matched = REMARK_KG_PATTERN.exec(remark)
            const kg =
              matched !== null && Number.isFinite(Number(matched[1])) && Number(matched[1]) > 0
                ? Math.round(Number(matched[1]) * 10) / 10
                : MIGRATE_DEFAULT_DRAW_KG
            // 道次本身没有批次字段，统一按作品挂的批次归属回填
            const batchId = pieceBatch.get(pieceId) ?? ''
            drawsToAdd.push({
              id: `draw-mig-${String(step.id)}`,
              pieceId,
              drawSeq: nextSeq,
              stepId: String(step.id ?? ''),
              batchId,
              kg,
              operator: typeof step.operator === 'string' ? step.operator : '',
              drawnAt: typeof step.createdAt === 'string' && step.createdAt !== '' ? step.createdAt : stamp,
              remark: `旧数据迁移自第 ${String(step.seq ?? '?')} 道取料工序${remark === '' ? '' : `：${remark}`}`,
              state: '已落账',
              rejectReason: '',
              attempts: 1,
              postedAt: stamp,
              migrated: true,
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            })
          })
        if (drawsToAdd.length > 0) {
          await tx.table('draws').bulkAdd(drawsToAdd)
        }

        // 迁移 7：批次补齐熔化车间账字段。
        // 历史批次只登记了余量：出料量按迁移过来的已落账道次回填，投料量 = 出料量 + 余量，
        // 使升级前的旧账按「取料量之和 + 余量 = 投料量」轧平；后续差异只会来自新两本账。
        const outByBatch = new Map<string, number>()
        drawsToAdd.forEach((draw) => {
          if (draw.batchId === '' || !batchIds.has(draw.batchId)) return
          outByBatch.set(draw.batchId, Math.round(((outByBatch.get(draw.batchId) ?? 0) + draw.kg) * 10) / 10)
        })
        await tx.table('batches').toCollection().modify((row: Record<string, unknown>) => {
          const remain = typeof row.remainKg === 'number' && Number.isFinite(row.remainKg) ? row.remainKg : 0
          const out = outByBatch.get(String(row.id)) ?? 0
          if (typeof row.chargeKg !== 'number') row.chargeKg = Math.round((out + remain) * 10) / 10
          if (typeof row.outKg !== 'number') row.outKg = out
          if (typeof row.state !== 'string' || row.state === '') row.state = '在用'
          if (typeof row.remeltedFrom !== 'string') row.remeltedFrom = ''
        })
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

/** 删除窑炉：级联清理该窑下的料液批次；技师取料道次不随批次删除，留作对账凭据 */
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

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 补料：投料量与余量同步增加（出料量不动） */
export async function refillBatch(batchId: string, kg: number): Promise<void> {
  await db.transaction('rw', db.batches, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch) return
    await db.batches.update(batchId, {
      chargeKg: round1(batch.chargeKg + kg),
      remainKg: round1(batch.remainKg + kg),
      updatedAt: nowIso(),
    })
  })
}

/**
 * 回炉重熔：把旧批次的现存余量整锅转入一批新料（可改配方/色号）。
 * 旧批次封账（state=已回炉、余量清零），新批次继承其所属窑炉与转入余量；
 * 技师那份取料道次一律照旧保留，对账时仍归属旧批次。
 */
export async function remeltBatch(
  oldId: string,
  draft: Pick<GlassBatchDraft, 'furnaceId' | 'colorCode' | 'recipe' | 'meltDate' | 'tempC'>
): Promise<GlassBatch | null> {
  return db.transaction('rw', db.batches, async () => {
    const old = await db.batches.get(oldId)
    if (!old) return null
    const stamp = nowIso()
    const carryKg = round1(old.remainKg)
    await db.batches.update(oldId, {
      state: '已回炉',
      remainKg: 0,
      updatedAt: stamp,
    })
    const next: GlassBatch = {
      id: uuid('batch'),
      furnaceId: draft.furnaceId || old.furnaceId,
      colorCode: draft.colorCode.trim() || `${old.colorCode}-重熔`,
      recipe: draft.recipe.trim() || old.recipe,
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      chargeKg: carryKg,
      outKg: 0,
      remainKg: carryKg,
      state: '在用',
      remeltedFrom: oldId,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.batches.add(next)
    return next
  })
}

/* --------------------------- 取料道次（技师账） --------------------------- */

export async function listDraws(): Promise<MaterialDraw[]> {
  const rows = await db.draws.toArray()
  return rows.sort((a, b) => b.drawnAt.localeCompare(a.drawnAt) || b.drawSeq - a.drawSeq)
}

export async function listDrawsByPiece(pieceId: string): Promise<MaterialDraw[]> {
  const rows = await db.draws.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.drawSeq - b.drawSeq)
}

export async function putDraw(row: MaterialDraw): Promise<void> {
  await db.draws.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeDraw(id: string): Promise<void> {
  await db.draws.delete(id)
}

/** 落账结果：ok=false 时本道已按「已退回」留在技师账上，批次余量分文未动 */
export interface DrawPostResult {
  ok: boolean
  draw: MaterialDraw
  /** 落账后批次余量；退回时为当前余量 */
  remainKg: number
  reason: string
}

/**
 * 取料落账（两本账的唯一扣料入口）。
 * 在同一个 Dexie 读写下事务内完成：
 *   1. 读批次当时余量；2. 余量足额 → 扣 remainKg、累计 outKg，道次记「已落账」；
 *      不足 / 批次缺失或已回炉 → 只把本道记「已退回」并写明原因，不动余量、不动别人的道次。
 * 两个终端（浏览器标签页）同时保存时，IndexedDB 事务串行提交，晚到的一次自然读到被扣后的余量而被退回。
 */
export async function postDraw(draft: MaterialDrawDraft & { stepId?: string; id?: string }): Promise<DrawPostResult> {
  const kg = round1(draft.kg)
  const stamp = nowIso()
  return db.transaction('rw', db.draws, db.batches, async () => {
    const existing = draft.id !== undefined ? await db.draws.get(draft.id) : undefined
    // 重试只允许针对「已退回」的本道；已落账道次不能重复扣料
    if (existing !== undefined && existing.state !== '已退回') {
      return { ok: false, draw: existing, remainKg: NaN, reason: '该道次已落账，不能重复提交。' }
    }

    const drawSeq = existing?.drawSeq ?? (await db.draws.where('pieceId').equals(draft.pieceId).count()) + 1
    const attempts = (existing?.attempts ?? 0) + 1
    const base: MaterialDraw = {
      id: existing?.id ?? draft.id ?? uuid('draw'),
      pieceId: draft.pieceId,
      drawSeq,
      stepId: existing?.stepId ?? draft.stepId ?? '',
      batchId: draft.batchId,
      kg,
      operator: draft.operator?.trim() ?? '',
      drawnAt: draft.drawnAt ?? stamp,
      remark: draft.remark?.trim() ?? '',
      state: '已退回',
      rejectReason: '',
      attempts,
      postedAt: stamp,
      migrated: existing?.migrated ?? false,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }

    const batch = await db.batches.get(draft.batchId)
    let reason = ''
    if (!batch) {
      reason = `料液批次不存在或已被删除，本道退回、未扣料；请改选有效批次后只按技师侧重试。`
    } else if (batch.state === '已回炉') {
      reason = `批次「${batch.colorCode}」已回炉封账（余量 0 kg），本道退回、未扣料；请改选新批次后重试。`
    } else if (round1(batch.remainKg - kg) < 0) {
      reason = `余量不足：批次「${batch.colorCode}」当前余量仅 ${round1(batch.remainKg)} kg，本道申请 ${kg} kg；本条已退回、未扣料，别人已取走的不动。`
    }

    if (reason !== '') {
      const returned: MaterialDraw = { ...base, state: '已退回', rejectReason: reason }
      await db.draws.put(returned)
      return { ok: false, draw: returned, remainKg: batch?.remainKg ?? 0, reason }
    }

    const nextRemain = round1((batch as GlassBatch).remainKg - kg)
    await db.batches.update(draft.batchId, {
      remainKg: nextRemain,
      outKg: round1((batch as GlassBatch).outKg + kg),
      updatedAt: stamp,
    })
    const posted: MaterialDraw = { ...base, state: '已落账', rejectReason: '', postedAt: stamp }
    await db.draws.put(posted)
    return { ok: true, draw: posted, remainKg: nextRemain, reason: '' }
  })
}

/** 落账失败后的本侧重试：只重提技师这本账上的退回道次，可改批次/取量/操作人；熔化侧无补偿动作 */
export async function retryDraw(
  id: string,
  patch?: Partial<Pick<MaterialDrawDraft, 'batchId' | 'kg' | 'operator' | 'drawnAt' | 'remark'>>
): Promise<DrawPostResult> {
  const existing = await db.draws.get(id)
  if (!existing) {
    throw new Error('取料道次不存在，无法重试。')
  }
  return postDraw({
    id: existing.id,
    pieceId: existing.pieceId,
    stepId: existing.stepId,
    batchId: patch?.batchId ?? existing.batchId,
    kg: patch?.kg ?? existing.kg,
    operator: patch?.operator ?? existing.operator,
    drawnAt: patch?.drawnAt ?? existing.drawnAt,
    remark: patch?.remark ?? existing.remark,
  })
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 删除作品：级联清理工序、退火与检验记录。
 * 技师取料道次不删——它是按料液批次对账的凭据，删除作品后仍以「作品已删除」挂在批次下。
 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
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
  /** v3 新增：技师取料道次（旧版 v2 存档导入时缺省按空数组处理） */
  draws?: MaterialDraw[]
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

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.draws],
    async () => {
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
      // v2 老存档没有 chargeKg / outKg / state / remeltedFrom：按盘点余量归一化（出料量未知先置 0，
      // 投料量置为余量本身），并在对账页通过结存/出料差异暴露历史账目缺口，不阻断导入。
      await db.batches.bulkPut(
        snapshot.batches.map((row) => ({
          ...row,
          chargeKg: typeof row.chargeKg === 'number' ? row.chargeKg : row.remainKg,
          outKg: typeof row.outKg === 'number' ? row.outKg : 0,
          state: row.state === '已回炉' ? '已回炉' : '在用',
          remeltedFrom: typeof row.remeltedFrom === 'string' ? row.remeltedFrom : '',
          revision: ROW_REVISION,
        }))
      )
      await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
      // v2 老存档无取料道次可导：保持空表，后续取料按新两本账登记
      if (Array.isArray(snapshot.draws) && snapshot.draws.length > 0) {
        await db.draws.bulkPut(snapshot.draws.map((row) => ({ ...row, revision: ROW_REVISION })))
      }
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.draws],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.draws.clear(),
      ])
    }
  )
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
