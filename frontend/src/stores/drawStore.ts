/**
 * 技师取料道次状态管理（Pinia）—— 技师那本账
 * 每件作品的取料道次记：用哪批料、取多少、操作人、批次快照与落账状态。
 * 落账按批次「当时余量」扣；两个终端同时保存、晚到的一次只退回本条（余量不足），
 * 别人取走的不动。落账失败只在技师侧重试这一条，熔化车间侧不动。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Draw, DrawDraft, DrawPostResult } from '../types/draw'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import { db, initDatabase, listDraws, postDraw, removeDraw } from '../utils/db'
import { round1 } from '../utils/thermal'

let subscribed = false

export const useDrawStore = defineStore('draw', () => {
  const draws = ref<Draw[]>([])
  const batches = ref<GlassBatch[]>([])
  const pieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)

  const rejectedDraws = computed<Draw[]>(() => draws.value.filter((row) => row.state === '已退回'))
  const postedDraws = computed<Draw[]>(() => draws.value.filter((row) => row.state === '已落账'))

  const batchById = computed<Map<string, GlassBatch>>(() => new Map(batches.value.map((row) => [row.id, row])))
  const pieceById = computed<Map<string, Piece>>(() => new Map(pieces.value.map((row) => [row.id, row])))

  function drawsOfPiece(pieceId: string): Draw[] {
    return draws.value
      .filter((row) => row.pieceId === pieceId)
      .sort((a, b) => a.seq - b.seq || b.updatedAt.localeCompare(a.updatedAt))
  }

  function postedKgOfBatch(batchId: string): number {
    return round1(
      draws.value
        .filter((row) => row.batchId === batchId && row.state === '已落账')
        .reduce((acc, row) => acc + row.drawKg, 0),
    )
  }

  /** 该作品下一个可用的取料道次序号 */
  function nextSeqOfPiece(pieceId: string): number {
    const list = drawsOfPiece(pieceId)
    return list.reduce((max, row) => Math.max(max, row.seq), 0) + 1
  }

  /** 该道次是否已存在取料记录（一道次只记一条） */
  function findByPieceSeq(pieceId: string, seq: number): Draw | undefined {
    return draws.value.find((row) => row.pieceId === pieceId && row.seq === seq)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [drawRows, batchRows, pieceRows] = await Promise.all([
            db.draws.toArray(),
            db.batches.toArray(),
            db.pieces.toArray(),
          ])
          return { drawRows, batchRows, pieceRows }
        }).subscribe({
          next: ({ drawRows, batchRows, pieceRows }) => {
            draws.value = [...drawRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            batches.value = batchRows
            pieces.value = pieceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取取料道次数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化取料道次数据失败'
      loading.value = false
    }
  }

  /**
   * 登记一笔取料道次（首次）。
   * 成功 → 同事务扣批次出料量 / 余量；失败（余量不足 / 批次缺失）→ 只退回技师这一条。
   */
  async function submitDraw(draft: DrawDraft): Promise<DrawPostResult> {
    const result = await postDraw(draft, null)
    revision.value += 1
    lastMessage.value = result.message
    return result
  }

  /**
   * 技师侧重试：只把本条「已退回」的取料道次重新拿去落账，
   * 可改批次 / 用量 / 操作人；不触碰熔化车间侧其它记录与别的技师取料道次。
   */
  async function retryDraw(drawId: string, patch?: Partial<Pick<DrawDraft, 'batchId' | 'drawKg' | 'operator' | 'stepId'>>): Promise<DrawPostResult> {
    const existing = draws.value.find((row) => row.id === drawId)
    if (existing === undefined) {
      return {
        ok: false,
        draw: null as unknown as Draw,
        remainKg: 0,
        message: '该取料道次不存在，无法重试',
      }
    }
    const draft: DrawDraft = {
      pieceId: existing.pieceId,
      seq: existing.seq,
      stepId: patch?.stepId ?? existing.stepId,
      batchId: patch?.batchId ?? existing.batchId,
      drawKg: patch?.drawKg ?? existing.drawKg,
      operator: patch?.operator ?? existing.operator,
    }
    const result = await postDraw(draft, existing)
    revision.value += 1
    lastMessage.value = result.message
    return result
  }

  /** 放弃退回中的取料道次（只删技师这一条，批次侧从未被扣过，无需补偿） */
  async function discardRejected(drawId: string): Promise<void> {
    const existing = draws.value.find((row) => row.id === drawId)
    if (existing === undefined || existing.state !== '已退回') return
    await removeDraw(drawId)
    revision.value += 1
    lastMessage.value = `第 ${existing.seq} 道退回的取料记录已撤销（批次侧未发生扣减）`
  }

  /** 刷新（页面需要时手动拉一次；正常以 liveQuery 订阅为准） */
  async function refresh(): Promise<Draw[]> {
    const rows = await listDraws()
    draws.value = rows
    return rows
  }

  return {
    draws,
    batches,
    pieces,
    loading,
    ready,
    error,
    lastMessage,
    revision,
    rejectedDraws,
    postedDraws,
    batchById,
    pieceById,
    drawsOfPiece,
    postedKgOfBatch,
    nextSeqOfPiece,
    findByPieceSeq,
    loadAll,
    submitDraw,
    retryDraw,
    discardRejected,
    refresh,
  }
})
