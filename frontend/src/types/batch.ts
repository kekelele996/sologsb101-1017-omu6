/**
 * 料液批次（GlassBatch）——熔化车间账
 * 熔化车间在批次上记投料量、累计出料量、配方与余量；技师取料按当时余量原子扣减。
 * 批次可回炉重熔（remeltedFrom）或改配方（recipe 直接更新），技师侧取料道次不受影响。
 */

/** 批次状态：在用 / 已回炉（重熔后原批次封账，余量清零，取料道次仍可对账） */
export type BatchState = '在用' | '已回炉'

export interface GlassBatch {
  id: string
  /** 所属熔化炉 / 坩埚炉 */
  furnaceId: string
  /** 色号 */
  colorCode: string
  /** 配方（改配方只改熔化侧这本账，技师已落账的道次保留原记录） */
  recipe: string
  /** 熔化日期 YYYY-MM-DD */
  meltDate: string
  /** 出料温度（℃） */
  tempC: number
  /** 累计投料量（kg）：含初始投料与历次补料 */
  chargeKg: number
  /** 累计出料量（kg）：仅由技师取料道次落账成功时累加，熔化车间不手工改 */
  outKg: number
  /** 剩余量（kg）：投料量 − 累计出料量，落账时原子读改写 */
  remainKg: number
  /** 批次状态 */
  state: BatchState
  /** 若由其他批次回炉重熔而来，记录原批次 id；原批次置为「已回炉」 */
  remeltedFrom: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑料液批次的表单草稿（熔化车间账：投料量、配方、余量；出料量仅查看） */
export interface GlassBatchDraft {
  furnaceId: string
  colorCode: string
  recipe: string
  meltDate: string
  tempC: number
  chargeKg: number
  remainKg: number
  state: BatchState
}
