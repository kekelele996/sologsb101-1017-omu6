/**
 * 技师取料账状态管理（Pinia）
 * 每件作品的取料道次单独记账：用哪批料、取多少、操作人、落账状态。
 * 落账走 postDraw 原子事务——按批次当时余量扣；两个终端同时保存时晚到的一条只退回本道、
 * 写明余量不足，别人取走的不动。退回道次只按技师本侧 retryDraw 重试，熔化侧无补偿动作。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { MaterialDraw, MaterialDrawDraft } from '../types/draw'
import {
  DB_SCHEMA_VERSION,
  countAll,
  db,
  initDatabase,
  postDraw,
  removeDraw,
  retryDraw,
  type DrawPostResult,
} from '../utils/db'

/** 取料台账筛选条件 */
export interface DrawFilters {
  keyword: string
  pieceId: string
  batchId: string
  state: MaterialDraw['state'] | 'all'
}

const EMPTY_FILTERS: DrawFilters = { keyword: '', pieceId: 'all', batchId: 'all', state: 'all' }

let subscribed = false

export const useDrawStore = defineStore('draw', () => {
  const draws = ref<MaterialDraw[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<DrawFilters>({ ...EMPTY_FILTERS })

  const postedDraws = computed<MaterialDraw[]>(() => draws.value.filter((row) => row.state === '已落账'))
  const returnedDraws = computed<MaterialDraw[]>(() => draws.value.filter((row) => row.state === '已退回'))

  /** 已落账取料量合计（kg） */
  const totalPostedKg = computed<number>(() =>
    Math.round(postedDraws.value.reduce((acc, row) => acc + row.kg, 0) * 10) / 10
  )

  function drawsOfPiece(pieceId: string): MaterialDraw[] {
    return draws.value.filter((row) => row.pieceId === pieceId).sort((a, b) => a.drawSeq - b.drawSeq)
  }

  /** 某作品已落账取料量合计（kg） */
  function postedKgOfPiece(pieceId: string): number {
    return Math.round(
      drawsOfPiece(pieceId)
        .filter((row) => row.state === '已落账')
        .reduce((acc, row) => acc + row.kg, 0) * 10
    ) / 10
  }

  const visibleDraws = computed<MaterialDraw[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return draws.value.filter((draw) => {
      if (filters.pieceId !== 'all' && draw.pieceId !== filters.pieceId) return false
      if (filters.batchId !== 'all' && draw.batchId !== filters.batchId) return false
      if (filters.state !== 'all' && draw.state !== filters.state) return false
      if (keyword === '') return true
      return (
        draw.operator.toLowerCase().includes(keyword) ||
        draw.remark.toLowerCase().includes(keyword) ||
        draw.kg.toString().includes(keyword)
      )
    })
  })

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(() => db.draws.toArray()).subscribe({
          next: (rows) => {
            draws.value = [...rows].sort(
              (a, b) => b.drawnAt.localeCompare(a.drawnAt) || b.drawSeq - a.drawSeq
            )
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取取料道次失败'
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

  function setFilters(patch: Partial<DrawFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /**
   * 登记取料并落账：同时写技师本账与扣批次余量（同一事务）。
   * 余量不足 / 批次已回炉时只退回本道，批次余量与别人的道次不动。
   */
  async function register(draft: MaterialDrawDraft, stepId?: string): Promise<DrawPostResult> {
    const result = await postDraw({ ...draft, stepId })
    revision.value += 1
    lastMessage.value = result.ok
      ? `取料已落账：${result.draw.kg} kg，批次余量 ${result.remainKg} kg`
      : `取料已退回：${result.reason}`
    return result
  }

  /**
   * 落账失败后的本侧重试：只重提技师账上的退回道次（可改批次/取量/操作人/时间/备注）。
   * 不产生任何熔化侧补偿动作；重试成功才扣当时余量。
   */
  async function retry(
    id: string,
    patch?: Partial<Pick<MaterialDrawDraft, 'batchId' | 'kg' | 'operator' | 'drawnAt' | 'remark'>>
  ): Promise<DrawPostResult> {
    const result = await retryDraw(id, patch)
    revision.value += 1
    lastMessage.value = result.ok
      ? `重试成功，取料已落账：${result.draw.kg} kg，批次余量 ${result.remainKg} kg`
      : `重试仍被退回：${result.reason}`
    return result
  }

  async function deleteDraw(id: string): Promise<void> {
    await removeDraw(id)
    revision.value += 1
    lastMessage.value = '取料道次已从技师账删除（批次余量不回补）'
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    draws,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    postedDraws,
    returnedDraws,
    totalPostedKg,
    visibleDraws,
    drawsOfPiece,
    postedKgOfPiece,
    loadAll,
    setFilters,
    resetFilters,
    register,
    retry,
    deleteDraw,
    refreshCounts,
  }
})
