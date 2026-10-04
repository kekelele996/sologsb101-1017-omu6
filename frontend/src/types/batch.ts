/**
 * 料液批次（GlassBatch）—— 熔化车间那本账
 * 批次上记出料量、配方和余量：
 * - chargeKg 投料量（熔化车间登记/补料时写入）
 * - outKg    出料量累计（技师落账取料时由本侧事务累加）
 * - remainKg 余量（= 投料量 - 出料量，落账时按当时余量扣减）
 * - version  乐观锁版本：每次出料 / 回炉重熔 / 改配方 +1，用于两个终端并发保存时的晚到判定
 */
export interface GlassBatch {
  id: string
  /** 所属熔化炉 / 坩埚炉 */
  furnaceId: string
  /** 色号 */
  colorCode: string
  /** 配方（改配方后旧的取料道次仍保留其落账时的配方快照） */
  recipe: string
  /** 熔化日期 YYYY-MM-DD */
  meltDate: string
  /** 出料温度（℃） */
  tempC: number
  /** 投料量（kg） */
  chargeKg: number
  /** 出料量累计（kg） */
  outKg: number
  /** 剩余量（kg） */
  remainKg: number
  /** 熔炼轮次：回炉重熔一次 +1 */
  cycle: number
  /** 乐观锁版本号：出料 / 回炉 / 改配方都会 +1 */
  version: number
  /** 是否为 v3 迁移回填的历史行（true 表示投料/出料为迁移估算，对账可能有差） */
  migrated?: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑料液批次的表单草稿（熔化车间侧） */
export interface GlassBatchDraft {
  furnaceId: string
  colorCode: string
  recipe: string
  meltDate: string
  tempC: number
  /** 登记时的投料量（kg） */
  chargeKg: number
}
