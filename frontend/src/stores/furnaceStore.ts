/**
 * 窑炉与料液状态管理（Pinia）—— 熔化车间那本账
 * 维护窑炉列表、料液批次的「投料量 / 配方 / 出料量 / 余量」与乐观锁版本。
 * 熔化车间侧不直接取料：出料只由技师落账取料道次时在同一事务内扣减。
 * 本侧动作落库失败时只记录本侧待办（pendingOp），重试只动本侧，不碰技师账。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Furnace, FurnaceDraft, FurnaceState, FurnaceType } from '../types/furnace'
import type { GlassBatch, GlassBatchDraft } from '../types/batch'
import type { Draw } from '../types/draw'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  changeBatchRecipe,
  countAll,
  db,
  initDatabase,
  putBatch,
  putFurnace,
  refillBatch,
  remeltBatch,
  removeBatch,
  removeFurnace,
} from '../utils/db'
import { isLowRemain, round1 } from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 窑炉筛选条件 */
export interface FurnaceFilters {
  keyword: string
  type: FurnaceType | 'all'
  state: FurnaceState | 'all'
}

/** 单台窑炉的派生统计 */
export interface FurnaceStat {
  furnaceId: string
  batchCount: number
  totalChargeKg: number
  totalOutKg: number
  totalRemainKg: number
  lowCount: number
  /** 关联作品数（通过料液批次反查） */
  pieceCount: number
}

/**
 * 熔化车间侧落库失败的待办（只属于本侧）。
 * 保存失败（如 IndexedDB 瞬时错误）时记下，点「本侧重试」只重新提交本侧动作，
 * 技师侧的取料道次完全不动。
 */
export interface MeltPendingOp {
  id: string
  kind: 'create-batch' | 'edit-batch' | 'remelt' | 'refill' | 'recipe' | 'create-furnace' | 'edit-furnace'
  label: string
  payload: unknown
  createdAt: string
  lastError: string
}

const EMPTY_FILTERS: FurnaceFilters = { keyword: '', type: 'all', state: 'all' }

const EMPTY_STAT: Omit<FurnaceStat, 'furnaceId'> = {
  batchCount: 0,
  totalChargeKg: 0,
  totalOutKg: 0,
  totalRemainKg: 0,
  lowCount: 0,
  pieceCount: 0,
}

let subscribed = false

export const useFurnaceStore = defineStore('furnace', () => {
  const furnaces = ref<Furnace[]>([])
  const batches = ref<GlassBatch[]>([])
  /** 技师账取料道次（本页对账需要，只读） */
  const draws = ref<Draw[]>([])
  const pieces = ref<{ id: string; batchId: string }[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<FurnaceFilters>({ ...EMPTY_FILTERS })
  /** 本侧落库失败待办（只按本侧重试） */
  const pendingOps = ref<MeltPendingOp[]>([])

  const meltingFurnaces = computed<Furnace[]>(() =>
    furnaces.value.filter((row) => row.type === '熔化炉' || row.type === '坩埚炉')
  )
  const annealingFurnaces = computed<Furnace[]>(() => furnaces.value.filter((row) => row.type === '退火窑'))
  const lowRemainBatches = computed<GlassBatch[]>(() => batches.value.filter((row) => isLowRemain(row.remainKg)))

  const stats = computed<Record<string, FurnaceStat>>(() => {
    const result: Record<string, FurnaceStat> = {}
    furnaces.value.forEach((furnace) => {
      const list = batches.value.filter((row) => row.furnaceId === furnace.id)
      const batchIds = new Set(list.map((row) => row.id))
      result[furnace.id] = {
        furnaceId: furnace.id,
        batchCount: list.length,
        totalChargeKg: round1(list.reduce((acc, row) => acc + row.chargeKg, 0)),
        totalOutKg: round1(list.reduce((acc, row) => acc + row.outKg, 0)),
        totalRemainKg: round1(list.reduce((acc, row) => acc + row.remainKg, 0)),
        lowCount: list.filter((row) => isLowRemain(row.remainKg)).length,
        pieceCount: pieces.value.filter((row) => batchIds.has(row.batchId)).length,
      }
    })
    return result
  })

  const visibleFurnaces = computed<Furnace[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return furnaces.value.filter((furnace) => {
      if (filters.type !== 'all' && furnace.type !== filters.type) return false
      if (filters.state !== 'all' && furnace.state !== filters.state) return false
      if (keyword === '') return true
      return (
        furnace.code.toLowerCase().includes(keyword) ||
        furnace.type.toLowerCase().includes(keyword) ||
        furnace.fuelType.toLowerCase().includes(keyword)
      )
    })
  })

  function statOf(furnaceId: string): FurnaceStat {
    return stats.value[furnaceId] ?? { furnaceId, ...EMPTY_STAT }
  }

  function batchesOf(furnaceId: string): GlassBatch[] {
    return batches.value.filter((row) => row.furnaceId === furnaceId)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [furnaceRows, batchRows, pieceRows, drawRows] = await Promise.all([
            db.furnaces.toArray(),
            db.batches.toArray(),
            db.pieces.toArray(),
            db.draws.toArray(),
          ])
          return { furnaceRows, batchRows, pieceRows, drawRows }
        }).subscribe({
          next: ({ furnaceRows, batchRows, pieceRows, drawRows }) => {
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            batches.value = [...batchRows].sort((a, b) => b.meltDate.localeCompare(a.meltDate))
            pieces.value = pieceRows.map((row) => ({ id: row.id, batchId: row.batchId }))
            draws.value = [...drawRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取窑炉数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<FurnaceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /** 记录本侧落库失败待办（另一边不动） */
  function pushPendingOp(op: Omit<MeltPendingOp, 'id' | 'createdAt'> & { id?: string }): string {
    const id = op.id ?? uuid('melt-op')
    pendingOps.value.unshift({
      id,
      createdAt: nowIso(),
      kind: op.kind,
      label: op.label,
      payload: op.payload,
      lastError: op.lastError,
    })
    return id
  }

  function dropPendingOp(id: string): void {
    pendingOps.value = pendingOps.value.filter((row) => row.id !== id)
  }

  /**
   * 执行一个熔化车间侧动作；落库失败时只在本侧挂一条待办（技师侧完全不动）。
   * 返回是否成功，页面据此关闭弹窗或提示「已挂本侧重试」。
   */
  async function runSide(
    kind: MeltPendingOp['kind'],
    label: string,
    payload: unknown,
    fn: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (err) {
      pushPendingOp({ kind, label, payload, lastError: err instanceof Error ? err.message : '本地写入失败' })
      lastMessage.value = `熔化车间侧「${label}」落账失败，已挂到本侧重试队列；技师侧取料道次未受影响`
      revision.value += 1
      return false
    }
  }

  /** 只按本侧重试一条失败待办：重新提交本侧动作，不触碰另一边 */
  async function retryPendingOp(id: string): Promise<boolean> {
    const op = pendingOps.value.find((row) => row.id === id)
    if (op === undefined) return false
    try {
      const payload = op.payload as {
        draft?: FurnaceDraft
        batchId?: string
        batchDraft?: GlassBatchDraft
        recipe?: string
        chargeKg?: number
        meltDate?: string
        tempC?: number
        kg?: number
        furnaceId?: string
      }
      switch (op.kind) {
        case 'create-furnace':
          if (payload.draft) await createFurnace(payload.draft)
          break
        case 'edit-furnace':
          if (payload.furnaceId && payload.draft) await updateFurnace(payload.furnaceId, payload.draft)
          break
        case 'create-batch':
          if (payload.batchDraft) await createBatch(payload.batchDraft)
          break
        case 'edit-batch':
          if (payload.batchId && payload.batchDraft) await updateBatchMeta(payload.batchId, payload.batchDraft)
          break
        case 'recipe':
          if (payload.batchId && payload.recipe !== undefined) await changeRecipe(payload.batchId, payload.recipe)
          break
        case 'remelt':
          if (
            payload.batchId &&
            payload.recipe !== undefined &&
            payload.chargeKg !== undefined &&
            payload.meltDate !== undefined &&
            payload.tempC !== undefined
          ) {
            await remelt(payload.batchId, {
              recipe: payload.recipe,
              chargeKg: payload.chargeKg,
              meltDate: payload.meltDate,
              tempC: payload.tempC,
            })
          }
          break
        case 'refill':
          if (payload.batchId && payload.kg !== undefined) await refill(payload.batchId, payload.kg)
          break
      }
      dropPendingOp(id)
      lastMessage.value = `熔化车间侧「${op.label}」已按本侧重试成功（技师侧未改动）`
      revision.value += 1
      return true
    } catch (err) {
      op.lastError = err instanceof Error ? err.message : '本地写入失败'
      lastMessage.value = `熔化车间侧「${op.label}」重试仍失败，保留在本侧重试队列`
      revision.value += 1
      return false
    }
  }

  async function createFurnace(draft: FurnaceDraft): Promise<Furnace> {
    const stamp = nowIso()
    const row: Furnace = {
      id: uuid('furnace'),
      code: draft.code.trim() || '未编号窑炉',
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putFurnace(row)
    revision.value += 1
    lastMessage.value =
      row.type === '退火窑' ? `已新建退火窑「${row.code}」，窑位已进入窑位池` : `已新建窑炉「${row.code}」，可挂料液批次`
    return row
  }

  async function updateFurnace(furnaceId: string, draft: FurnaceDraft): Promise<void> {
    const existing = furnaces.value.find((row) => row.id === furnaceId)
    if (existing === undefined) return
    await putFurnace({
      ...existing,
      code: draft.code.trim() || existing.code,
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
    })
    revision.value += 1
  }

  async function deleteFurnace(furnaceId: string): Promise<void> {
    await removeFurnace(furnaceId)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '窑炉及其料液批次已删除；技师历史取料道次保留并在对账中标为批次缺失'
  }

  async function createBatch(draft: GlassBatchDraft): Promise<GlassBatch> {
    const stamp = nowIso()
    const chargeKg = round1(Math.max(0, draft.chargeKg))
    const row: GlassBatch = {
      id: uuid('batch'),
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || '未命名色号',
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      chargeKg,
      outKg: 0,
      remainKg: chargeKg,
      cycle: 1,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putBatch(row)
    revision.value += 1
    return row
  }

  /**
   * 编辑批次基础信息（色号 / 所属窑 / 日期 / 出料温度）。
   * 配方单独走 changeRecipe（乐观锁 +1）；投料量 / 出料量 / 余量不在普通编辑里直接改，
   * 避免熔化车间手工把余量改穿——补料走「补料」，重开走「回炉重熔」。
   */
  async function updateBatchMeta(batchId: string, draft: GlassBatchDraft): Promise<void> {
    const existing = batches.value.find((row) => row.id === batchId)
    if (existing === undefined) return
    await putBatch({
      ...existing,
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || existing.colorCode,
      meltDate: draft.meltDate,
      tempC: draft.tempC,
    })
    revision.value += 1
  }

  /** 改配方：本侧配方更新 + 乐观锁版本 +1；技师账旧道次的配方快照不动 */
  async function changeRecipe(batchId: string, recipe: string): Promise<void> {
    const next = await changeBatchRecipe(batchId, recipe)
    if (next === null) {
      lastMessage.value = '批次已不存在，改配方失败'
      return
    }
    revision.value += 1
    lastMessage.value = `「${next.colorCode}」配方已更新（第 ${next.cycle} 轮），版本号 ${next.version}；技师历史取料道次保留原配方快照`
  }

  /** 回炉重熔：新轮次清零出料、余量恢复为新投料量；技师旧轮次取料道次照旧 */
  async function remelt(batchId: string, payload: { recipe: string; chargeKg: number; meltDate: string; tempC: number }): Promise<void> {
    const next = await remeltBatch(batchId, payload)
    if (next === null) {
      lastMessage.value = '批次已不存在，回炉重熔失败'
      return
    }
    revision.value += 1
    lastMessage.value = `「${next.colorCode}」已回炉重熔（第 ${next.cycle} 轮），投料 ${next.chargeKg} kg、出料清零；技师账旧轮次取料道次照旧保留`
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await removeBatch(batchId)
    revision.value += 1
    lastMessage.value = '料液批次已从熔化车间账删除；技师取料道次保留，对账时按「批次缺失」单列'
  }

  /** 补料：本侧追加投料量（不动出料量、不动乐观锁版本），失败只在本侧挂待办 */
  async function refill(batchId: string, kg: number): Promise<boolean> {
    const next = await refillBatch(batchId, round1(Math.max(0, kg)))
    if (next === null) return false
    revision.value += 1
    lastMessage.value = `已为 ${next.colorCode} 补料 ${round1(Math.max(0, kg))} kg，投料量 ${next.chargeKg} kg、余量 ${next.remainKg} kg`
    return true
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    furnaces,
    batches,
    draws,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    pendingOps,
    meltingFurnaces,
    annealingFurnaces,
    lowRemainBatches,
    stats,
    visibleFurnaces,
    statOf,
    batchesOf,
    loadAll,
    setFilters,
    resetFilters,
    pushPendingOp,
    dropPendingOp,
    runSide,
    retryPendingOp,
    createFurnace,
    updateFurnace,
    deleteFurnace,
    createBatch,
    updateBatchMeta,
    changeRecipe,
    remelt,
    deleteBatch,
    refill,
    refreshCounts,
  }
})
