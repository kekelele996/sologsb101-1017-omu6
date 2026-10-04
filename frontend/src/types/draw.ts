/**
 * 取料道次（MaterialDraw）——技师账
 * 每件作品的每一次取料单独记一道：用哪批料、取多少、谁操作。
 * 落账时按批次当时余量原子扣减；两个终端同时保存时晚到的一条只退回本道并写明余量不足，
 * 别人已取走的不动。批次回炉重熔或改配方后，这些道次照旧保留用于对账。
 */

/** 落账状态：已落账（批次余量已扣）/ 已退回（余量不足，本道未扣任何料，可只按技师侧重试） */
export type DrawState = '已落账' | '已退回'

export const DRAW_STATE_OPTIONS: DrawState[] = ['已落账', '已退回']

export interface MaterialDraw {
  id: string
  /** 所属作品（技师账按作品归属） */
  pieceId: string
  /** 该作品内的取料道次序号，从 1 开始；退回后重试仍是同一道 */
  drawSeq: number
  /** 关联的吹制工序（取料道工序）；历史数据可能没有对应工序 */
  stepId: string
  /** 取料时登记使用的料液批次 */
  batchId: string
  /** 取料量（kg） */
  kg: number
  /** 操作人 */
  operator: string
  /** 取料时间（datetime-local / ISO 片段） */
  drawnAt: string
  /** 备注 */
  remark: string
  /** 落账状态 */
  state: DrawState
  /** 退回原因（state = 已退回 时写明，如：余量不足，当前余量 3.0 kg） */
  rejectReason: string
  /** 落账尝试次数：首次为 1，每次重试 +1 */
  attempts: number
  /** 最近一次落账成功 / 退回时间 */
  postedAt: string
  /** 迁移回填标记：由旧版「取料」工序升级而来 */
  migrated: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 登记取料 / 重试时的表单草稿（技师侧本账内容） */
export interface MaterialDrawDraft {
  pieceId: string
  batchId: string
  kg: number
  operator: string
  drawnAt: string
  remark: string
}
