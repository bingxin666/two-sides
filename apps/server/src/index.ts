/**
 * 两面 · 后端入口（Bun + Hono）
 *
 * 挂载：
 *   /api/v1/health
 *   /api/v1/hot
 *   /api/v1/questions/:qid/analysis   (GET 主端点 / POST 重试)
 *   /api/v1/auth/zhihu/*              (增强层 · 登录)
 *   /api/v1/me/related                (增强层 · 与你有关)
 *
 * 产品入口只有热榜（2026-09-13 收敛）：/api/v1/search 已随「无用户输入」一并移除。
 *
 * 启动自检只打印「是否配置 + 长度 + SHA-256 短前缀」，不打印任何凭证本体。
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { API_V1, ENDPOINTS } from '@two-sides/contract'
import { getDb } from './db'
import { env, zhihuSecretStatus } from './env'
import { log } from './log'
import { recoverOnBoot } from './jobs'
import { pregenerateOnBoot, startPregenerateCron } from './pregenerate'
import { registryDiagnostics } from './llm/provider'
import { failResp } from './http'
import { analysisRoutes } from './routes/analysis'
import { healthRoutes } from './routes/health'
import { hotRoutes } from './routes/hot'
import { authRoutes, publicCallbackRoutes } from './routes/auth'
import { meRoutes } from './routes/me'
import { isLive } from './zhihu/client'
import { todayKey } from './time'

const app = new Hono()

app.use('*', cors())

// 请求日志：只记方法与路径，不记 query
app.use('*', async (c, next) => {
  const started = performance.now()
  await next()
  log.debug('http', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms: Math.round(performance.now() - started),
  })
})

app.route(API_V1, healthRoutes)
app.route(API_V1, hotRoutes)
app.route(API_V1, analysisRoutes)
app.route(API_V1, authRoutes)
app.route(API_V1, meRoutes)

// The public callback is also supported because the registered OAuth URI may
// be https://<domain>/callback rather than the API-prefixed endpoint.
app.route('/callback', publicCallbackRoutes)

// 便捷别名（运维探活用），与契约路径指向同一实现
app.route('/health', healthRoutes)

app.notFound((c) => failResp(c, 404, '接口不存在'))

app.onError((e, c) => {
  // 不把内部异常细节回给前端（也可能夹带凭证片段）
  log.error('http.unhandled', {
    path: new URL(c.req.url).pathname,
    err: e instanceof Error ? e.name : typeof e,
    message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
  })
  return failResp(c, 500, '服务内部错误')
})

/* ------------------------------ 启动自检 ------------------------------ */

log.info('boot.env', {
  port: env.PORT,
  dbPath: env.DB_PATH,
  pipelineMode: env.PIPELINE_MODE,
  jobTimeoutSec: env.JOB_TIMEOUT_SEC,
  retryCooldownSec: env.RETRY_COOLDOWN_SEC,
  llmRpmLimit: env.LLM_RPM_LIMIT,
  zhihuLive: isLive(),
  // 凭证指纹：只含「是否配置 + 长度 + SHA-256 短前缀」，不含值本身
  zhihuCred: zhihuSecretStatus(),
  endpoints: ENDPOINTS,
})
log.info('boot.providers', registryDiagnostics())

getDb() // 提前建库建表，避免首个请求承担迁移耗时
recoverOnBoot()
startPregenerateCron() // 每日 00:30（Asia/Shanghai）热榜预生成，进程内 timer
void pregenerateOnBoot() // 当日缺失则后台补生成并落 SQLite，不阻塞 HTTP 启动

log.info('boot.ready', { date: todayKey(), port: env.PORT })

export default {
  port: env.PORT,
  fetch: app.fetch,
}
