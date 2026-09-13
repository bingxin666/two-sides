# 两面 · Two Sides

> 知乎黑客松 2026 参赛作品 —— **把社区回答提炼成判断，每条判断展开成一条取向光谱。**

输入一个知乎问题，我们把社区回答提炼成十几条判断；每条判断展开成一条**取向光谱**：两端由判断自身的内容定义，每一档上站着真实答主（昵称 + 认证 + 权威级 + 可回跳原文的原话）。

**产品不评判对错，只呈现分布。**

---

## 两条硬约束（贯穿全部开发）

| # | 约束 | 含义 |
|---|---|---|
| 1 | **预置热榜题打开即出结果** | 预置题的渲染路径**零实时生成调用**，全部读按日分析快照；冷门 / 未预置问题才进入懒生成（T1 生成态），快照落地后同样秒开 |
| 2 | **一切可回溯** | 每条判断绑定原话引用，每个归位绑定理由，全部可点回知乎原文 |

---

## 核心体验

| 界面 | 用户看到什么 |
|---|---|
| **N1 首页** | 知乎热榜「光幕」弹幕道 —— 预置热榜题横向流动，点任意一条直接进问题页 |
| **N2 问题页** | 十几条判断化作钉在光幕上的「钉子」，每颗标注「N 人表态 · 分歧度 X」；首屏 4 条，其余折叠 |
| **N3 判断展开** | 判断展开成一条五档取向光谱：两端是判断自己的语义轴（不预设正反），每档站着真实答主；点答主看原话 + 归位理由 + 「查看知乎原文」；底部「看山解读」给出中立综述 |
| **T1 生成中** | 冷门题的四阶段进度（提取 → 归并 → 取向 → 综述），诚实告知当前阶段与已处理样本数 |
| **失败态** | 接口失败 / 额度耗尽 / 空数据都有真实降级提示，不是白屏；只有 `retryable` 的错误才给「重试」按钮 |

---

## 仓库结构

```
two-sides/
├── apps/
│   ├── web/                # Vue 3 + Vite + TypeScript 前端
│   │   ├── src/router/     #   路由
│   │   ├── src/stores/     #   Pinia 状态
│   │   ├── src/api/        #   接口层（mock / live 双模式）
│   │   ├── src/mock/       #   开发期 fixture，不等后端即可跑全链路
│   │   ├── src/components/ #   UI 组件
│   │   ├── src/pages/      #   N1 / N2 / N3 / T1 / 失败态
│   │   └── src/styles/     #   设计稿视觉还原
│   └── server/             # Bun + Hono + TypeScript 后端
├── packages/
│   └── contract/           # 共享类型 + zod schema —— API 契约唯一事实源
├── config/
│   └── providers.yaml      # LLM 服务商与 Agent 绑定（只写 env 变量名，不写值）
├── docs/                   # 01 开发总览 / 02 前端 / 03 后端 / 04 环境变量
├── docker-compose.yml      # web(Caddy 静态) + server(API) + SQLite 具名卷
└── Caddyfile               # :8080 站点块 + /api/* 反代
```

**契约先行**：`packages/contract` 是前后端唯一接口事实源。前端用 mock fixture 跑全链路（`VITE_API_MODE=mock`），后端按同一份类型实现，联调只换 baseURL。

---

## 本地启动

### 前置

- **Node** ≥ 20（推荐 22）
- **pnpm** 11+  — `npm i -g pnpm`
- **Bun** 1.1+（仅后端需要）— Windows：`powershell -c "irm bun.sh/install.ps1 | iex"`

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

然后填入你自己的值。**`.env` 已被 `.gitignore` 忽略，永远不会进仓库。**

最小可跑集（前端 mock 模式，不消耗任何知乎额度）：

```bash
TZ=Asia/Shanghai
VITE_API_MODE=mock      # 前端读本地 fixture，不碰真实接口
```

联调 / 上线集（会真实调用知乎与外部 LLM，注意日额度）：

```bash
ZHIHU_ACCESS_SECRET=...   # 知乎开放平台 → 申请新 Access Secret
DEEPSEEK_API_KEY=...      # 管线主力模型
ZHIHU_LIVE=1              # ⚠️ 与下一行必须成对设置
PIPELINE_MODE=llm         # ⚠️ 真实分析管线；漏配凭证/开关会直接报错，不会改跑假数据
VITE_API_MODE=live
VITE_API_BASE=/api/v1
```

### 3. 启动

```bash
pnpm web        # 前端 dev server（Vite）
pnpm server     # 后端 dev server（Bun + Hono）
```

### 4. 质量闸门

```bash
pnpm typecheck  # 全 workspace 类型检查
pnpm build      # 全 workspace 构建
```

---

## 技术选型

| 层 | 选型 | 为什么 |
|---|---|---|
| 前端 | **Vue 3 + Vite + TypeScript** + Pinia + vue-router | 开发者最熟，出活最快 |
| 视觉渲染 | **CSS + Canvas 混合** | 光幕 / 钉子 / 卡片走 CSS + DOM（最贴合设计稿）；迷你光谱走 Canvas（圆点命中检测、DPR 精确绘制） |
| 后端 | **Bun + Hono（TypeScript）** | 轻快；LLM 调用统一走 OpenAI 兼容原生 `fetch`，不绑重 SDK，留 Node 回退路径 |
| 编排 | **自写轻量并发编排**（Promise 池 + 信号量 + 任务状态表） | 无框架依赖，评委和队友都看得懂；LangGraph / 队列对此项目是过度设计 |
| LLM | **多服务商配置层**，每个 Agent 独立绑定 `provider/model`；知乎直答单独封装 | 不押注单一供应商；直答仅用于综述，永不挪用 |
| 存储 | **SQLite**（`bun:sqlite`） | 按日分析快照键 `{东八区日期}:{qid}` 天然主键，单文件零运维 |
| 部署 | **自有 VPS + Docker Compose** | 静态层 + API + 定时任务一个 compose 拉起，完全可控 |

---

## 环境变量

完整清单与安全边界见 [`docs/04-环境变量与密钥清单.md`](./docs/04-环境变量与密钥清单.md)。此处只列**变量名**——**任何真实值都只存在于部署平台的 Secret 或本地 `.env`**。

### 服务端（`apps/server`）

| 变量 | 必填 | 默认值 | 用途 |
|---|---|---|---|
| `ZHIHU_ACCESS_SECRET` | ✅ | — | 开放平台调用方凭证，搜索 / 热榜 / 直答全部用它做 Bearer 鉴权 |
| `DEEPSEEK_API_KEY` | ✅ | — | 提取 / 归并 / 取向 Agent 的主力模型 |
| `GLM_API_KEY` | 建议 | — | fallback 模型 + 直答降级时的综述兜底 |
| `QWEN_API_KEY` | 可选 | — | 取向 Agent 的第二备选 |
| `TZ` | ✅ | `Asia/Shanghai` | 固定东八区；代码内另有时区兜底，双保险 |
| `SERVER_PORT` | 可选 | `3000` | Hono 监听端口，Caddy 反代到此 |
| `ZHIDUAN_DB_PATH` | 可选 | `./data/two-sides.db` | SQLite 单文件路径 |
| `ZHIHU_ZHIDA_MODEL` | 可选 | `zhida-thinking-1p5` | 直答模型档位 |
| `PROVIDERS_CONFIG` | 可选 | `config/providers.yaml` | 服务商与 Agent 绑定配置路径 |
| `PREGENERATE_TOP` | 可选 | `30` | 每日预生成题数上限（热榜取前 N 题） |
| `ANALYSIS_RETRY_COOLDOWN_SEC` | 可选 | `60` | `failed` 后再试的冷却窗口，防连点打穿额度 |
| `ANALYSIS_JOB_TIMEOUT_SEC` | 可选 | `180` | 单 job 总时限，超时置 `timeout` |
| `LLM_RPM_LIMIT` | 可选 | `1000` | 全局令牌桶；提取/取向默认并发提高后，仍以此限制总请求速率，可按服务商承载调低 |
| `PIPELINE_EXTRACT_CONCURRENCY` | 可选 | `30` | 单题提取批次并发；按服务商承载调节 |
| `PIPELINE_ORIENT_CONCURRENCY` | 可选 | `100` | 单题取向并发；按服务商承载调节 |
| `PREGENERATE_CONCURRENCY` | 可选 | `4` | 热榜预生成跨题并发；搜索与 LLM 仍受各自限流约束 |
| `ZHIHU_LIVE` | 可选 | `1` | 只有 `=1` 且凭证已配置才允许真实知乎调用；未开启或未配置时直接返回错误。生产应与 `PIPELINE_MODE=llm` 一起设置。 |
| `PIPELINE_MODE` | 可选 | `llm` | `llm` 走真实多智能体管线；`fake` 仅在显式指定时走本地确定性管线。未配置时默认 `llm`，非法值直接拒绝启动。 |
| `PIPELINE_FAKE_DURATION_MS` | 可选 | `12000` | fake 管线的模拟时长，留足时间观察轮询与 T1 进度态 |
| `RECOVER_ON_BOOT` | 可选 | `true` | 启动时是否重放上一轮未完成的 job |
| `ORIGAMI_API_KEY` | 可选 | — | `providers.yaml` 中中转服务商 `origami` 的 key |

> ⚠️ **生产请同时设置 `ZHIHU_LIVE=1`、`PIPELINE_MODE=llm` 并填好凭证**。缺少任一项时真实请求会返回错误，系统不会静默切换到 fake/mock 数据；只有明确指定 `PIPELINE_MODE=fake` 或前端 `VITE_API_MODE=mock` 才会启用本地假数据。

**增强层（OAuth）—— 凭证未获批时整层不启用，不影响主流程**：`ZHIHU_OAUTH_APP_ID`、`ZHIHU_OAUTH_APP_KEY`、`ZHIHU_OAUTH_REDIRECT_URI`。

### 前端（`apps/web`）

| 变量 | 必填 | 默认值 | 用途 |
|---|---|---|---|
| `VITE_API_MODE` | 开发期 | — | `mock` 读本地 fixture / `live` 走真实接口 |
| `VITE_API_BASE` | 部署 | `/api/v1` | 接口基础路径 |

> ⚠️ **三种知乎凭证不要混**：Access Secret 鉴权「调用方」；OAuth App ID / App Key 用于用户授权；用户 access token 代表该用户。**App Key 不能当 Access Secret 用。**

---

## 接口一览

前缀 `/api/v1`，响应统一包 `{ code, data }`，错误 `{ code, message }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/questions/:qid/analysis` | **唯一主端点**。ready → `200` + 完整 Analysis；未完成 / 失败 → `202` + `ProgressResp`；qid 非法 → `404` |
| `POST` | `/questions/:qid/analysis` | 仅用于失败重试 / 强制重跑（`?force=1`），幂等 |
| `GET` | `/hot` | 当日热榜，只含已 ready 的预置题；当日无数据 → `404` |
| `GET` | `/health` | `{ ok, date, quota }`，额度查询本身不消耗额度 |
| `GET` | `/auth/zhihu/authorize` | 增强层 · 302 到知乎授权页 |
| `GET` | `/auth/zhihu/callback` | 增强层 · 换 token（不留存，只取公开范围数据） |
| `GET` | `/callback` | 公网 OAuth 回调别名（与活动页登记地址一致） |
| `GET` | `/me/opposite` | 增强层 · 「光谱另一侧」推荐；未授权 `403` |

> **进度不单独开端点**：进度就是 `202` 的响应体，前端只轮询一个 URL，状态机从三端点降到一端点。

---

## 部署（Docker Compose）

```bash
cp .env.example .env          # 填入真实值
pnpm install
# 前端构建期变量：产品线上为 live 模式（mock 仅为离线应急）
VITE_API_MODE=live VITE_API_BASE=/api/v1 pnpm -F @two-sides/web build   # 产出 apps/web/dist（Caddy 挂载）
pnpm -F @two-sides/server build # 产出 apps/server/dist/index.js（server 镜像 COPY）
docker compose up -d --build
```

- `web` 监听 `127.0.0.1:8080`，Caddy 托管静态产物并反代 `/api/*` → `server:3000`
- `server` 不对外暴露端口；SQLite 落在具名卷 `two-sides-server-data`
- **每日预生成（cron）为进程内定时器**（每日 `Asia/Shanghai 00:30`，取热榜前 `PREGENERATE_TOP` 题），无外部 crontab、无内部触发端点；端点未实现前快照由懒生成路径（`GET /analysis` 未命中即隐式触发）自然填充，落地后同样秒开
- **TLS / 对外反代不归 compose 管**：自行部署反代指向 `127.0.0.1:8080` 终止 HTTPS
- 秒开验收标准：热榜页与预置题 **TTFB < 200ms、渲染路径无任何实时生成调用**
- ⚠️ **上线检查**：`.env` 里 `ZHIHU_LIVE=1` 与 `PIPELINE_MODE=llm` 必须成对设置，并确认知乎与 LLM 凭证已配置；缺失时应看到明确错误，而不是假数据

---

## 安全红线

1. 涉密变量（`ZHIHU_ACCESS_SECRET`、`ZHIHU_OAUTH_APP_KEY`、OAuth token、各 LLM key）**只存在于部署平台 Secret 或本地 `.env`**
2. `config/providers.yaml` 只写 `apiKeyEnv` 变量名，值一律从 env 注入
3. 凭证绝不进入：前端代码与响应、URL、日志、错误信息、截图、演示视频
4. 诊断信息只展示来源、是否已配置、长度、SHA-256 短前缀
5. 提交前必查：仓库、前端响应、日志、截图、视频里没有凭证

---

## 赛程

| 节点 | 时间 |
|---|---|
| 报名与组队截止 | 2026-09-13 00:00 |
| 作品提交窗口 | 2026-09-13 10:00 – 09-15 10:00 |
| **最终截止** | **2026-09-15 10:00，不补交** |

---

## 文档

- [`docs/01-开发总览.md`](./docs/01-开发总览.md) —— 系统长什么样、为什么这么定
- [`docs/02-前端开发文档.md`](./docs/02-前端开发文档.md) —— 页面、状态、视觉还原
- [`docs/03-后端开发文档.md`](./docs/03-后端开发文档.md) —— 端点、管线、状态机、部署
- [`docs/04-环境变量与密钥清单.md`](./docs/04-环境变量与密钥清单.md) —— 凭证单一事实源

