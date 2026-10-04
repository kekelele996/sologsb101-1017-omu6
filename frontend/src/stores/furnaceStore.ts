/**
 * 熔化车间账状态管理（Pinia）
 * 维护窑炉列表与料液批次：批次上记投料量、累计出料量、配方与余量。
 * - 取料不在这里直接扣：唯一扣料入口是技师账 postDraw（按当时余量原子扣减 outKg / remainKg）；
 * - 补料同步加投料量与余量；回炉重熔把旧批余量转入新批并给旧批封账；改配方只改本账 recipe。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Furnace, FurnaceDraft, FurnaceState, FurnaceType } from '../types/furnace'
import type { GlassBatch, GlassBatchDraft } from '../types/batch'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
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
import { isLowRemain } from '../utils/thermal'
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
  totalRemainKg: number
  lowCount: number
  /** 关联作品数（通过料液批次反查） */
  pieceCount: number
}

const EMPTY_FILTERS: FurnaceFilters = { keyword: '', type: 'all', state: 'all' }

const EMPTY_STAT: Omit<FurnaceStat, 'furnaceId'> = {
  batchCount: 0,
  totalRemainKg: 0,
  lowCount: 0,
  pieceCount: 0,
}

let subscribed = false

export const useFurnaceStore = defineStore('furnace', () => {
  const furnaces = ref<Furnace[]>([])
  const batches = ref<GlassBatch[]>([])
  const pieces = ref<{ id: string; batchId: string }[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<FurnaceFilters>({ ...EMPTY_FILTERS })

  const meltingFurnaces = computed<Furnace[]>(() =>
    furnaces.value.filter((row) => row.type === '熔化炉' || row.type === '坩埚炉')
  )
  const annealingFurnaces = computed<Furnace[]>(() => furnaces.value.filter((row) => row.type === '退火窑'))
  const lowRemainBatches = computed<GlassBatch[]>(() =>
    batches.value.filter((row) => row.state === '在用' && isLowRemain(row.remainKg))
  )

  const stats = computed<Record<string, FurnaceStat>>(() => {
    const result: Record<string, FurnaceStat> = {}
    furnaces.value.forEach((furnace) => {
      const list = batches.value.filter((row) => row.furnaceId === furnace.id)
      const batchIds = new Set(list.map((row) => row.id))
      result[furnace.id] = {
        furnaceId: furnace.id,
        batchCount: list.length,
        totalRemainKg: Math.round(list.reduce((acc, row) => acc + row.remainKg, 0) * 10) / 10,
        lowCount: list.filter((row) => row.state === '在用' && isLowRemain(row.remainKg)).length,
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

  function batchById(batchId: string): GlassBatch | undefined {
    return batches.value.find((row) => row.id === batchId)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [furnaceRows, batchRows, pieceRows] = await Promise.all([
            db.furnaces.toArray(),
            db.batches.toArray(),
            db.pieces.toArray(),
          ])
          return { furnaceRows, batchRows, pieceRows }
        }).subscribe({
          next: ({ furnaceRows, batchRows, pieceRows }) => {
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            batches.value = [...batchRows].sort((a, b) => b.meltDate.localeCompare(a.meltDate))
            pieces.value = pieceRows.map((row) => ({ id: row.id, batchId: row.batchId }))
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
    lastMessage.value = '窑炉及其料液批次已删除；技师取料道次保留用于对账'
  }

  /**
   * 登记料液批次（熔化车间账）。
   * 新批投料量按表单填写，尚未出料 outKg=0；余量初始等于投料量（可由表单覆写为盘点余量）。
   */
  async function createBatch(draft: GlassBatchDraft): Promise<GlassBatch> {
    const stamp = nowIso()
    const charge = draft.chargeKg
    const row: GlassBatch = {
      id: uuid('batch'),
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || '未命名色号',
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      chargeKg: charge,
      outKg: 0,
      remainKg: draft.remainKg,
      state: draft.state,
      remeltedFrom: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putBatch(row)
    revision.value += 1
    lastMessage.value = `料液批次「${row.colorCode}」已登记：投料 ${charge} kg，取料由技师在取料台账按余量扣`
    return row
  }

  /**
   * 编辑批次（熔化车间账）。
   * 改配方只改本账 recipe，技师已落账道次照旧保留；投料量/余量按盘点值更新，累计出料量不手工改。
   */
  async function updateBatch(batchId: string, draft: GlassBatchDraft): Promise<void> {
    const existing = batches.value.find((row) => row.id === batchId)
    if (existing === undefined) return
    await putBatch({
      ...existing,
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || existing.colorCode,
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      chargeKg: draft.chargeKg,
      remainKg: draft.remainKg,
      state: draft.state,
    })
    revision.value += 1
    lastMessage.value = `批次「${draft.colorCode.trim() || existing.colorCode}」熔化账已更新（改配方不影响技师历史道次）`
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await removeBatch(batchId)
    revision.value += 1
    lastMessage.value = '料液批次已删除；技师取料道次保留，对账时会列为无批次归属'
  }

  /** 补料：投料量与余量同步增加（累计出料量不动） */
  async function refill(batchId: string, kg: number): Promise<void> {
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch === undefined) return
    await refillBatch(batchId, kg)
    revision.value += 1
    lastMessage.value = `已为 ${batch.colorCode} 补料 ${kg} kg（投料量与余量同步增加）`
  }

  /**
   * 回炉重熔：旧批现存余量整锅转入新批，可同时改配方/色号。
   * 旧批封账（余量清零、状态已回炉）；技师取料道次照旧挂在旧批上，对账时仍按旧批归属。
   */
  async function remelt(
    oldId: string,
    draft: Pick<GlassBatchDraft, 'furnaceId' | 'colorCode' | 'recipe' | 'meltDate' | 'tempC'>
  ): Promise<GlassBatch | null> {
    const created = await remeltBatch(oldId, draft)
    revision.value += 1
    if (created !== null) {
      lastMessage.value = `已回炉重熔为新批「${created.colorCode}」，转入余量 ${created.remainKg} kg；旧批封账，技师历史道次保留`
    }
    return created
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    furnaces,
    batches,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    meltingFurnaces,
    annealingFurnaces,
    lowRemainBatches,
    stats,
    visibleFurnaces,
    statOf,
    batchesOf,
    batchById,
    loadAll,
    setFilters,
    resetFilters,
    createFurnace,
    updateFurnace,
    deleteFurnace,
    createBatch,
    updateBatch,
    deleteBatch,
    refill,
    remelt,
    refreshCounts,
  }
})
