/**
 * 取料道次（Draw）—— 技师那本账
 * 给每件作品的每个取料道次单独记一行：用哪批料、取多少、操作人。
 * 落账时按批次「当时余量」扣减；两个终端同时保存、晚到的那次只退回这一条并写明余量不足，
 * 别人取走的不动。批次回炉重熔或改配方后，本侧记录连同批次快照照旧保留。
 */

/** 取料道次落账状态 */
export type DrawState = '已落账' | '已退回'

/** 退回原因 */
export type DrawRejectReason = '余量不足' | '批次不存在' | ''

export const DRAW_STATE_OPTIONS: DrawState[] = ['已落账', '已退回']

export interface Draw {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 作品名快照（作品被删后技师账仍可对账） */
  pieceName: string
  /** 取料道次序号（作品内从 1 开始，一件作品可有多个取料道次） */
  seq: number
  /** 关联的吹制工序 id（可能为空：旧数据迁移或先记取料后建工序） */
  stepId: string
  /** 用哪批料（批次 id） */
  batchId: string
  /** 批次色号快照：批次改配方 / 回炉后本侧照旧 */
  batchColorCode: string
  /** 批次配方快照：落账当时的配方 */
  batchRecipe: string
  /** 批次熔炼轮次快照 */
  batchCycle: number
  /** 取多少（kg） */
  drawKg: number
  /** 操作人 */
  operator: string
  /** 落账状态 */
  state: DrawState
  /** 退回时写明的原因（已落账时为空串） */
  rejectReason: DrawRejectReason
  /** 退回 / 最近一次落账时批次的当时余量（kg），用于向技师说明差多少 */
  remainAtReject: number
  /** 最近一次落账尝试时看到的批次 version（用于并发晚到判定展示） */
  seenVersion: number
  /** 尝试次数（首次落账 + 每次本侧重试 +1） */
  attempts: number
  /** 是否为旧数据迁移回填（缺批次 / 缺用量的取料道次按作品挂的批次回填） */
  migrated?: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 技师登记 / 重试取料道次的表单草稿 */
export interface DrawDraft {
  pieceId: string
  seq: number
  stepId: string
  batchId: string
  drawKg: number
  operator: string
}

/**
 * 落账结果（两本账在同一个 Dexie 事务内提交；事务内判定失败则整笔回滚，
 * 随后只把技师这一条写成「已退回」，批次侧与别人的记录不动）。
 */
export interface DrawPostResult {
  ok: boolean
  draw: Draw
  /** 落账成功后批次的最新余量；退回时为批次当时余量 */
  remainKg: number
  /** 面向技师的说明（含余量不足 / 批次不存在） */
  message: string
}
