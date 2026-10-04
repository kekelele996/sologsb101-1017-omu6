# 玻璃吹制工序与退火窑编排台（sologsb101-1017）

面向玻璃工作室的窑务排产员：把每件作品的取料、吹制、塑形、开模、收口逐道工序排定，
分配退火窑位与温度曲线，出炉检验并归档；窑位冲突时禁止提交，不合格自动生成返工提示。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22817**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbglassblow` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期时间选择、进度条、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22817） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbglassblow`，`v1 → v2` 为 Piece 增加 craft 索引并回填默认值，`v2 → v3` 拆两本账：熔化车间批次台账（投料/出料/余量/乐观锁版本）+ 技师取料道次台账（draws），旧「取料」工序按作品批次回填 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1017/
├── README.md
├── docker-compose.yml          # name: gbglassblow，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前作品上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # furnace.ts batch.ts draw.ts piece.ts step.ts anneal.ts inspect.ts
        ├── stores/             # furnaceStore.ts drawStore.ts pieceStore.ts annealStore.ts
        ├── components/common/  # StageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useStepProgress.ts useIdbTable.ts
        ├── pages/              # 5 个模块页面
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # thermal.ts db.ts reconcile.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/furnaces` | `pages/FurnaceList.vue` | 窑炉与**熔化车间料液台账**：批次记投料量/配方/出料量/余量与乐观锁版本，补料、回炉重熔、改配方，本侧失败挂本侧重试队列，并按批次与技师账对账标差 |
| `/pieces` | `pages/PieceList.vue` | 作品登记与设计尺寸录入：按工艺与状态筛选、设计尺寸比例校验、显示工序完成度与当前道次 |
| `/pieces/:id/steps` | `pages/StepDetail.vue` | 吹制工序逐道记录 + **技师取料道次账**（哪批料/取多少/操作人，按当时余量扣，晚到只退本条，退回仅本侧重试）、拖拽排序、回填温度/时长/操作人、前序未完成阻断进入退火排位 |
| `/annealing` | `pages/AnnealingBoard.vue` | 退火窑位分配与曲线编排：窑位占用表、**窑位冲突时禁用提交**、状态流转、出炉回写作品状态 |
| `/export` | `pages/ExportView.vue` | 出炉检验登记（不合格生成返工提示）+ JSON 结构版本查看与导入导出 + 窑务 CSV 汇总 |

`/` 重定向到 `/furnaces`，未匹配路径统一回落到 `/furnaces`。
**层级路由支持直接深链**：把 `http://localhost:22817/pieces/piece-morning-vase/steps` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「作品不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbglassblow`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`
  * `db.version(1)`：建立全部表与 `[pieceId+seq]` 复合索引；
  * `db.version(2)`：**为 `Piece` 增加 `craft` 索引并回填默认值**，同时补齐其余索引与字段：
    * `.upgrade()` 中逐行回填 `revision` / `createdAt` / `updatedAt`；
    * `pieces.craft` 缺失时回填 `吹制`，`pieces.state` 缺失时回填 `设计中`；
    * `steps.state` 缺失时按历史记录视为 `已完成`，避免升级后被误判为待办；
    * `anneals` 补齐 `outAt` 与 `curveSeg`，`inspects` 补齐 `defectNote`。
  * `db.version(3)`：**两本账改造**（熔化车间批次台账 + 技师取料道次台账）：
    * `batches` 补 `chargeKg` 投料量 / `outKg` 出料量 / `cycle` 熔炼轮次 / `version` 乐观锁版本：
      历史批次只有余量，迁移时投料量按当时余量承接、出料量记 0 并标 `migrated`，差异交给对账页标出，不篡改旧账；
    * 新增 `draws` 表：旧「取料」工序**按归属迁移**成技师取料道次——
      **缺批次和用量的取料道次按作品挂的批次回填**（`pieces.batchId`），用量从「取 X kg」备注解析，解析不到记 0 并标 `migrated`。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `furnaces` | id | code, type, state, fuelType, createdAt, updatedAt |
  | `batches`（熔化车间账） | id | furnaceId, colorCode, meltDate, remainKg, **outKg, version, cycle** |
  | `pieces` | id | batchId, state, artist, **craft**, name |
  | `steps` | id | pieceId, **[pieceId+seq]**, seq, state, name |
  | `draws`（技师账） | id | pieceId, **[pieceId+seq]**, batchId, state, seq, stepId |
  | `anneals` | id | pieceId, kilnSlot, state, inAt, curveSeg |
  | `inspects` | id | pieceId, date, result, inspector |

* **两本账记账规则**：
  * **熔化车间在料液批次上记出料量、配方和余量**：`chargeKg` 投料量、`outKg` 出料量累计、`remainKg` 余量、`version` 乐观锁版本；
    登记批次时投料量即初始余量，补料只加投料与余量，回炉重熔开新一轮（轮次 +1、出料清零、余量恢复为投料量），改配方仅更新配方与版本。
  * **技师给每件作品的取料道次记用哪批料、取多少和操作人**：`draws` 一行一道次，存批次色号 / 配方 / 轮次快照。
  * **并发扣减**：技师保存取料时在**同一个 Dexie 事务**内重读批次、按「当时余量」判定并扣减出料 / 余量（version +1）。
    两个终端同时保存、晚到且余量不足（或批次已不存在）时，事务回滚——**只退回技师这一条**并写明「余量不足 / 当时余量 / 尝试版本」，
    批次与别人已取走的记录一律不动；被退回道次不计入出料量。
  * **批次回炉重熔或改配方，技师那份取料道次照旧留着**：批次版本 / 轮次前进，draws 内历史快照不改。
  * **按料液批次对账**（`utils/reconcile.ts`）：技师当前轮次「已落账」取料量之和应等于批次出料量，
    投料量 - 出料量应等于余量；对不上按批标出差额与差异说明（取料账差 / 余量差），历史轮次取料单列，引用已删批次的取料道次单列「批次缺失」。
  * **落账失败只按本侧重试**：熔化车间侧失败（如本地写入异常）挂本侧待办队列，只重试本侧动作；
    技师侧退回道次只重试这一条（可改批次 / 用量 / 操作人），另一边与他人记录不触碰。
* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `furnaces` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **窑炉 → 料液批次 → 作品 → 吹制工序 → 技师取料道次 → 退火 → 出炉检验**，两本账天然对平：
  * 3 台窑炉（KILN-01 熔化炉 / KILN-02 坩埚炉 / AN-01 退火窑）；
  * 4 批料液（投料 = 出料 + 余量；含 `A-207` 剩余 42 kg，故意低于 60 kg 补料阈值用于验证高亮与提醒）；
  * 5 件作品（覆盖四种状态与三种工艺）、17 道吹制工序（每件 2–5 道，seq 连续）；
  * 5 条技师取料道次（每道「取料」工序一条，用量合计 = 批次出料量：G-101 8.6 / A-207 3.1 / C-330 9.5 / T-045 7.8 kg）；
  * 4 条退火记录（窑位 A1/A2/A3/B1 互不冲突，覆盖已出炉 / 退火中 / 待入窑）；
  * 3 条出炉检验（含一条「裂纹」不合格 + 一条返工后复检合格）。
  * 固定 id 如 `piece-morning-vase`、`piece-frost-bottle` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的作品 id」这一界面偏好，不存业务数据。
* 删除窑炉会级联清理其料液批次（技师取料道次保留、对账单列「批次缺失」）；删除作品会级联清理其工序、取料道次、退火与检验记录（均在同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22817
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/thermal.ts`）

* **退火曲线时长换算**
  * 升温：20 ℃ → 560 ℃，按 120 ℃/h；
  * 保温：560 ℃ 恒温，每 5 mm 壁厚保温 1.2 小时（壁厚越大保温越久）；
  * 缓冷：560 ℃ → 60 ℃，按 40 ℃/h。
  三段合计即该作品的**理论退火时长**，壁厚直接决定总时长。
* **窑位占用判重**：同一窑位的时间窗 `[入窑, 出炉]` 重叠即判定冲突；未出炉时以「入窑 + 该曲线段理论时长」作为临时出炉时间参与判重。
  **冲突时提交按钮禁用**并给出冲突的既有记录说明。
* **温度单位换算**：℃ ↔ ℉（`cToF` / `fToC`）。
* **工序温度校验**：不得超过所选窑炉的 `maxTempC`，且应落在工艺适宜区间（吹制 900–1200 ℃ / 铸造 800–1150 ℃ / 热塑 700–1000 ℃）附近。
* **设计尺寸校验**：壁厚需 ≥ 1.5 mm 且小于设计高度的 1/8，否则给出成型与退火难度提示。
* **前序阻断**：任一前序工序未推进到「已完成」，`/pieces/:id/steps` 的「进入退火排位」会给出明确阻断原因。
* **状态回写**：退火状态推进到「已出炉」即把作品状态回写为「已退火」；登记出炉检验后回写为「已检验」；
  判定不合格时生成返工提示，**原始工序记录完整保留**。
* **料液扣减（两本账）**：熔化车间批次记投料量 / 出料量 / 余量 / 配方 / 乐观锁版本，技师逐道次记取料（批次快照、用量、操作人）。
  取料落账在单事务内按批次**当时余量**扣减，绝不扣到负数；两终端并发、晚到且不足时只退回技师本条并写明「余量不足」，别人取走的不动；
  回炉重熔 / 改配方不动技师旧道次；按批次对账（当前轮次取料合计 = 出料量、投料 - 出料 = 余量），对不上标清差在哪批；
  两侧落账失败各自只在本侧重试。剩余量低于 60 kg 时列表行高亮并在顶部汇总提醒。
