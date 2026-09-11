/**
 * Provider 注册表 —— 加载 config/providers.yaml，按 Agent 名解析 provider/model
 *
 * docs/03 §3：调用方永远写 Agent 名，不接触 provider 细节。
 * failover 只在 Agent 级：主路径连续失败 N 次（默认 3）自动切 fallback，
 * 成功后计数归零并在下次调用回到主路径（保持行为可预期，不做跨供应商漂移）。
 *
 * 安全：yaml 里只有 env 变量名；解析出的 key 只进 Authorization 头，
 * diagnostics 只暴露「是否配置」，不给值。
 */

import { z } from 'zod'
import { chat, LlmError, type ChatMessage, type ChatResult } from './client'
import { env, hasEnv } from '../env'
import { log } from '../log'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* ------------------------------- schema ------------------------------- */

const RefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

const AgentSchema = RefSchema.extend({
  fallback: RefSchema.optional(),
})

const ProviderSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  /** 只写变量名，绝不能是密钥本身 */
  apiKeyEnv: z.string().min(1),
  models: z.array(z.string().min(1)).default([]),
})

const ConfigSchema = z.object({
  providers: z.array(ProviderSchema).min(1),
  agents: z.record(AgentSchema),
})

export type AgentName = 'extract' | 'merge' | 'orient' | 'summaryFallback'

/* ------------------------------- 加载 -------------------------------- */

/** Bun 的 YAML 解析器（内置，不引依赖）；typings 未声明时走宽松访问 */
function parseYaml(text: string): unknown {
  const yaml = (Bun as unknown as { YAML?: { parse: (s: string) => unknown } }).YAML
  if (!yaml) throw new Error('Bun.YAML unavailable — upgrade Bun or provide a parser')
  return yaml.parse(text)
}

/**
 * providers.yaml 的查找：优先 PROVIDERS_CONFIG，其次向上找仓库根 config/。
 * 因为 dev 时 cwd 可能是 apps/server，容器里是 /app。
 */
function locateConfig(): string {
  const candidates = [
    resolve(process.cwd(), env.PROVIDERS_CONFIG),
    resolve(process.cwd(), 'config/providers.yaml'),
    resolve(process.cwd(), '../../config/providers.yaml'),
    resolve(process.cwd(), '../config/providers.yaml'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`providers config not found; tried: ${candidates.join(', ')}`)
}

interface Provider {
  name: string
  baseUrl: string
  apiKeyEnv: string
  models: string[]
}

interface Agent {
  provider: string
  model: string
  fallback?: { provider: string; model: string }
}

interface Registry {
  providers: Map<string, Provider>
  agents: Map<string, Agent>
  path: string
}

let _registry: Registry | null = null

export function loadRegistry(force = false): Registry {
  if (_registry && !force) return _registry
  const path = locateConfig()
  const raw = parseYaml(readFileSync(path, 'utf8'))
  const parsed = ConfigSchema.parse(raw)

  const providers = new Map<string, Provider>()
  for (const p of parsed.providers) providers.set(p.name, p)
  const agents = new Map<string, Agent>()
  for (const [k, v] of Object.entries(parsed.agents)) agents.set(k, v)

  _registry = { providers, agents, path }
  log.info('llm.registry.loaded', {
    path,
    providers: [...providers.keys()],
    agents: [...agents.keys()],
  })
  return _registry
}

/* ------------------------------- 解析 -------------------------------- */

export interface ResolvedTarget {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  path: 'primary' | 'fallback'
}

const REQUIRED_AGENTS: AgentName[] = ['extract', 'merge', 'orient', 'summaryFallback']

function resolveRef(
  reg: Registry,
  ref: { provider: string; model: string },
  path: 'primary' | 'fallback',
): ResolvedTarget | null {
  const p = reg.providers.get(ref.provider)
  if (!p) return null
  const apiKey = process.env[p.apiKeyEnv]
  if (!apiKey) return null
  return { provider: p.name, baseUrl: p.baseUrl, apiKey, model: ref.model, path }
}

export function resolveAgent(
  agent: AgentName,
  path: 'primary' | 'fallback' = 'primary',
): ResolvedTarget | null {
  const reg = loadRegistry()
  const a = reg.agents.get(agent)
  if (!a) return null
  const ref = path === 'fallback' ? (a.fallback ?? a) : a
  return resolveRef(reg, ref, path)
}

/* ------------------------------ failover ------------------------------ */

const FAILOVER_THRESHOLD = Number(process.env.LLM_FAILOVER_THRESHOLD ?? 3)
const consecutiveFailures = new Map<AgentName, number>()

function failures(agent: AgentName): number {
  return consecutiveFailures.get(agent) ?? 0
}

function noteSuccess(agent: AgentName): void {
  if (consecutiveFailures.get(agent)) consecutiveFailures.set(agent, 0)
}

function noteFailure(agent: AgentName): void {
  consecutiveFailures.set(agent, failures(agent) + 1)
}

/* -------------------------------- 调用 -------------------------------- */

export interface CallOptions<T> {
  messages: ChatMessage[]
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 结构化输出校验（zod parse 包装） */
  validate?: (raw: string) => T
}

export interface AgentCallResult<T> extends ChatResult<T> {
  agent: AgentName
  provider: string
  path: 'primary' | 'fallback'
}

/**
 * 按 Agent 名调用 LLM。
 * 主路径不可用时（未配置 / 连续失败达阈值）自动切 fallback；
 * 两者都不可用抛 LlmError('config')，调用方映射为 llm_error。
 */
export async function callAgent<T = string>(
  agent: AgentName,
  opts: CallOptions<T>,
): Promise<AgentCallResult<T>> {
  const useFallback = failures(agent) >= FAILOVER_THRESHOLD
  const order: Array<'primary' | 'fallback'> = useFallback
    ? ['fallback', 'primary']
    : ['primary', 'fallback']

  let lastErr: unknown = null
  for (const path of order) {
    const target = resolveAgent(agent, path)
    // 「未配置」（yaml 里没绑 / env 里没 key）在解析期就被跳过：
    // 不发起请求、也不计入 failover 阈值 —— 否则 D1 场景下
    // deepseek/glm/qwen 都没配 key 时，每个请求都要先空转 3 次「假失败」才落到 origami。
    // 只有「真的发出去并失败了」才 noteFailure()。
    if (!target) continue
    try {
      const res = await chat<T>({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        messages: opts.messages,
        jsonMode: opts.jsonMode,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        validate: opts.validate,
      })
      noteSuccess(agent)
      log.info('llm.call.ok', {
        agent,
        provider: target.provider,
        model: target.model,
        path,
        latencyMs: res.latencyMs,
        tokens: res.usage?.totalTokens ?? 0,
      })
      return { ...res, agent, provider: target.provider, path }
    } catch (e) {
      lastErr = e
      const kind = e instanceof LlmError ? e.kind : 'network'
      log.warn('llm.call.fail', {
        agent,
        provider: target.provider,
        model: target.model,
        path,
        kind,
        consecutive: failures(agent) + 1,
      })
      noteFailure(agent)
      // 配置类问题直接试下一条路径；网络/解析问题也交给下一条路径兜底
      continue
    }
  }
  throw lastErr ?? new LlmError(`agent "${agent}" has no configured provider`, 'config')
}

/** 启动自检：每个 Agent 的主/备路径是否可解析（只给布尔，不给 key） */
export function registryDiagnostics(): {
  path: string
  agents: Array<{
    agent: string
    primary: { provider: string; model: string; configured: boolean }
    fallback?: { provider: string; model: string; configured: boolean }
  }>
} {
  let reg: Registry
  try {
    reg = loadRegistry()
  } catch (e) {
    return { path: `(load failed: ${e instanceof Error ? e.message : String(e)})`, agents: [] }
  }
  const out: Array<{
    agent: string
    primary: { provider: string; model: string; configured: boolean }
    fallback?: { provider: string; model: string; configured: boolean }
  }> = []
  for (const name of REQUIRED_AGENTS) {
    const a = reg.agents.get(name)
    if (!a) continue
    const p = reg.providers.get(a.provider)
    const entry: {
      agent: string
      primary: { provider: string; model: string; configured: boolean }
      fallback?: { provider: string; model: string; configured: boolean }
    } = {
      agent: name,
      primary: {
        provider: a.provider,
        model: a.model,
        configured: !!p && hasEnv(p.apiKeyEnv),
      },
    }
    if (a.fallback) {
      const fp = reg.providers.get(a.fallback.provider)
      entry.fallback = {
        provider: a.fallback.provider,
        model: a.fallback.model,
        configured: !!fp && hasEnv(fp.apiKeyEnv),
      }
    }
    out.push(entry)
  }
  return { path: reg.path, agents: out }
}
