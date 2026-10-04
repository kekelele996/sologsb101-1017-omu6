/**
 * 路由表：/furnaces、/draws、/reconcile、/pieces、/pieces/:id/steps、/annealing、/export
 * 层级路由支持直接深链访问（配合 nginx try_files 回退）；页面按路由懒加载自动分包。
 * - /furnaces：熔化车间账（窑炉与料液批次：投料 / 配方 / 出料 / 余量）
 * - /draws：技师账（每件作品的取料道次：批次 / 取量 / 操作人）
 * - /reconcile：两本账按料液批次对账
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/** 路由路径常量：全项目唯一来源，避免手写字符串不一致 */
export const ROUTES = {
  furnaces: '/furnaces',
  draws: '/draws',
  reconcile: '/reconcile',
  pieces: '/pieces',
  steps: (pieceId: string): string => `/pieces/${pieceId}/steps`,
  annealing: '/annealing',
  export: '/export',
} as const

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: ROUTES.furnaces },
  {
    path: '/furnaces',
    name: 'furnace-list',
    component: () => import('@/pages/FurnaceList.vue'),
    meta: { title: '熔化车间账 · 窑炉料液' },
  },
  {
    path: '/draws',
    name: 'draw-ledger',
    component: () => import('@/pages/DrawLedger.vue'),
    meta: { title: '技师取料台账' },
  },
  {
    path: '/reconcile',
    name: 'reconcile-board',
    component: () => import('@/pages/ReconcileBoard.vue'),
    meta: { title: '两本账按批次对账' },
  },
  {
    path: '/pieces',
    name: 'piece-list',
    component: () => import('@/pages/PieceList.vue'),
    meta: { title: '作品登记与设计尺寸' },
  },
  {
    path: '/pieces/:id/steps',
    name: 'step-detail',
    component: () => import('@/pages/StepDetail.vue'),
    meta: { title: '吹制工序逐道记录' },
  },
  {
    path: '/annealing',
    name: 'annealing-board',
    component: () => import('@/pages/AnnealingBoard.vue'),
    meta: { title: '退火窑位与曲线编排' },
  },
  {
    path: '/export',
    name: 'export-view',
    component: () => import('@/pages/ExportView.vue'),
    meta: { title: '出炉检验与结构版本' },
  },
  { path: '/:pathMatch(.*)*', redirect: ROUTES.furnaces },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '玻璃吹制工序与退火窑编排台'
  document.title = `${title} · 玻璃吹制工序与退火窑编排台`
})

export default router
