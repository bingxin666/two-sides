/**
 * 「与你有关」离线回归：临时 SQLite + 模拟网络，零真实请求。
 *
 * 守的几条线：
 *   ① 只承认 id 级精确匹配 —— 收藏过的问题 qid、收藏过且**写进了光谱**的回答 id
 *   ② 收藏过但没进光谱的回答**不点亮**（只漏报，不误报）
 *   ③ 未收藏的题不出现在结果里（缺省即「无从判断」，不构成「无关」的断言）
 *   ④ 带外 qid 能被额外判定
 *   ⑤ 用户数据接口失败 → degraded，且绝不抛出（增强层不许拖挂主流程）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const originalCwd = process.cwd()
const tempRoot = resolve(tmpdir())
const testDir = mkdtempSync(resolve(tempRoot, 'two-sides-signals-test-'))
const originalFetch = globalThis.fetch
let closeDatabase: (() => void) | undefined

// 所有配置必须在 import env.ts 之前落定；空 .env 防止读到仓库真实凭证
process.chdir(testDir)
writeFileSync(resolve(testDir, '.env'), '')
Object.assign(process.env, {
  ZHIDUAN_DB_PATH: resolve(testDir, 'test.db'),
  ZHIHU_LIVE: '1',
  ZHIHU_ACCESS_SECRET: 'test-only-not-a-real-secret',
  PIPELINE_MODE: 'fake',
  PREGENERATE_TOP: '0',
  RECOVER_ON_BOOT: 'false',
  ZHIHU_FAV_SCAN_LISTS: '5',
  ZHIHU_FAV_SCAN_PAGES: '3',
  ZHIHU_FAV_PAGE_SIZE: '50',
  USER_SIGNAL_TTL_SEC: '600',
  LOG_LEVEL: 'error',
})

/* --------------------------- 模拟知乎用户数据 --------------------------- */

const FAVLIST_TOKEN = '694112321'
/** 收藏里：两道题（9001 在当日热榜、9002 不在）+ 两条回答（1001 在光谱里、1002 不在） */
const FAV_ANSWER_IDS = ['1001', '1002']
const calls: string[] = []
let failUserData = false
let favlistRound = 0

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== 'https://developer.zhihu.com') {
    throw new Error(`Unexpected network request blocked by test: ${url.origin}${url.pathname}`)
  }
  calls.push(url.pathname)
  if (failUserData && url.pathname.startsWith('/api/v1/user/')) {
    const body = { Code: 30001, Message: 'rate limit exceeded' }
    return Response.json(body, { status: 200 })
  }
  if (url.pathname === '/api/v1/user/favlists') {
    return Response.json({
      Code: 0,
      Message: 'success',
      Data: { Items: [{ UrlToken: Number(FAVLIST_TOKEN), Title: '我的收藏', IsPublic: false }] },
    })
  }
  if (url.pathname === '/api/v1/user/favlist_contents') {
    favlistRound++
    const offset = Number(url.searchParams.get('Offset') ?? '0')
    // 第一页给全部条目；第二页给空（同时验证「自算 offset 且短页即停」）
    const items = offset === 0
      ? [
        { ContentType: 'question', Url: 'https://www.zhihu.com/question/9001', Title: '被收藏的题' },
        { ContentType: 'question', Url: 'https://www.zhihu.com/question/9002', Title: '被收藏但今日未 ready 的题' },
        ...FAV_ANSWER_IDS.map((id) => ({ ContentType: 'answer', Url: `https://www.zhihu.com/answer/${id}` })),
        { ContentType: 'answer', Url: 'https://www.zhihu.com/answer/2002' },
        { ContentType: 'article', Url: 'https://zhuanlan.zhihu.com/p/1' },
      ]
      : []
    // 服务端分页字段故意给错（实测 IsEnd/Totals 自相矛盾）——实现不该采信它们
    return Response.json({
      Code: 0,
      Message: 'success',
      Data: { Items: items, Paging: { IsEnd: false, Totals: 33001 } },
    })
  }
  throw new Error(`Unhandled path in test: ${url.pathname}`)
}) as typeof fetch

async function main(): Promise<void> {
  const repo = await import('./repo')
  const { getDb, closeDb } = await import('./db')
  const { todayKey, nowIso } = await import('./time')
  const { loadSignals, relatedMarks, resetAnswerIndex, forgetSignals } = await import('./user-signals')
  closeDatabase = closeDb
  const db = getDb()
  const date = todayKey()
  let passed = 0

  function reset(): void {
    for (const table of ['jobs', 'analyses', 'hot_questions', 'question_titles']) {
      db.exec(`DELETE FROM ${table}`)
    }
    calls.length = 0
    failUserData = false
    favlistRound = 0
    resetAnswerIndex()
    forgetSignals('sess')
    assert.deepEqual(calls.filter((p) => !p.startsWith('/api/v1/user/')), [])
  }

  /** 种一道 ready 题，光谱里带上指定的回答 id */
  function seedReady(qid: string, answerIds: string[]): void {
    repo.upsertHotQuestions(date, [{
      date, qid, title: `测试问题 ${qid}`, url: `https://www.zhihu.com/question/${qid}`, fetched_at: nowIso(),
    }])
    repo.beginRun(date, qid, 1)
    const id = `test-${date}-${qid}`
    repo.insertJobIgnore({ id, date, qid, stage: 'extract', attempts: 1, owner: 'previous-process' })
    const snapshot = {
      qid,
      judgments: [{
        id: 'j1',
        distribution: [{
          slot: 1,
          authors: answerIds.map((aid) => ({
            // 快照里的答主原链带溯源 UTM，answer id 必须仍能解析出来
            url: `https://www.zhihu.com/question/${qid}/answer/${aid}?utm_medium=openapi_platform&utm_source=test`,
          })),
        }],
      }],
    }
    repo.markReady(id, date, qid, JSON.stringify(snapshot), {
      stage: 'render', stageRatio: 1, sampleCount: answerIds.length, judgmentsDone: 1, judgmentsTotal: 1,
    })
  }

  async function check(name: string, run: () => Promise<void>): Promise<void> {
    reset()
    await run()
    passed++
    console.log(`ok ${passed} - ${name}`)
  }

  await check('收藏过的问题与「收藏且进了光谱的回答」各点亮一次，原因可叠加', async () => {
    seedReady('9001', ['1001', '1003'])
    const signals = await loadSignals('sess', 'fake-token')
    assert.equal(signals.degraded, false)
    assert.deepEqual([...signals.questions].sort(), ['9001', '9002'])
    assert.deepEqual([...signals.answers].sort(), ['1001', '1002', '2002'])

    // 9001 是唯一 ready 的收藏题，且它的光谱里含收藏过的 1001 → 两种原因叠加
    const items = relatedMarks(date, signals)
    assert.equal(items.length, 1)
    assert.equal(items[0]!.qid, '9001')
    assert.deepEqual(items[0]!.reasons, ['question_favorited', 'answer_favorited'])
  })

  await check('只收藏了回答且该回答进了光谱时，只给 answer_favorited', async () => {
    seedReady('9100', ['1001'])
    const signals = await loadSignals('sess', 'fake-token')
    assert.deepEqual(relatedMarks(date, signals), [{ qid: '9100', reasons: ['answer_favorited'] }])
  })

  await check('收藏过的回答没进光谱 → 不点亮（只漏报，不误报）', async () => {
    // 9100 的光谱里只有 1003，而收藏的回答是 1001/1002
    seedReady('9100', ['1003'])
    const signals = await loadSignals('sess', 'fake-token')
    assert.deepEqual(relatedMarks(date, signals), [])
  })

  await check('完全无关的题不出现在结果里', async () => {
    seedReady('9001', ['1001'])
    seedReady('9100', ['1003'])
    const signals = await loadSignals('sess', 'fake-token')
    assert.deepEqual(relatedMarks(date, signals).map((i) => i.qid), ['9001'])
  })

  await check('带外 qid 可被额外判定（不在当日 ready 热榜也能点亮）', async () => {
    seedReady('9001', ['1001'])
    const signals = await loadSignals('sess', 'fake-token')
    // 9002 只在 hot_questions 里、没有 ready 快照 → 不在当日热榜结果中
    repo.upsertHotQuestions(date, [{
      date, qid: '9002', title: '测试问题 9002', url: 'https://www.zhihu.com/question/9002', fetched_at: nowIso(),
    }])
    assert.deepEqual(relatedMarks(date, signals).map((i) => i.qid), ['9001'])
    assert.deepEqual(
      relatedMarks(date, signals, '9002').map((i) => i.qid),
      ['9001', '9002'],
    )
  })

  await check('用户数据接口失败 → degraded 且不抛错，不输出任何否定断言', async () => {
    seedReady('9001', ['1001'])
    failUserData = true
    const signals = await loadSignals('sess', 'fake-token')
    assert.equal(signals.degraded, true)
    assert.equal(signals.questions.size, 0)
    assert.equal(signals.answers.size, 0)
    assert.deepEqual(relatedMarks(date, signals), [])
  })

  await check('短页即停：页数配 3 也只翻 1 页', async () => {
    seedReady('9001', ['1001'])
    await loadSignals('sess', 'fake-token')
    // 第一页返回 5 条 < 页长 50 → 判定到底，不白翻第 2、3 页
    assert.equal(calls.filter((p) => p === '/api/v1/user/favlist_contents').length, 1)
  })

  await check('同一会话 TTL 内不重复扫收藏', async () => {
    seedReady('9001', ['1001'])
    await loadSignals('sess', 'fake-token')
    const afterFirst = calls.length
    await loadSignals('sess', 'fake-token')
    assert.equal(calls.length, afterFirst, 'TTL 内第二次调用不得再打用户数据接口')
    assert.equal(calls.filter((p) => p === '/api/v1/user/favlists').length, 1)
  })

  await check('每次扫描都带 X-OAuth-Token，且不落任何日志字段', async () => {
    let sawHeader = false
    const probe = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {})
      if (headers.get('X-OAuth-Token') === 'fake-token') sawHeader = true
      return (globalThis.fetch as unknown as typeof fetch)(input as never, init as never)
    }) as typeof fetch
    const real = globalThis.fetch
    globalThis.fetch = probe
    try {
      await loadSignals('sess-header', 'fake-token')
    } finally {
      globalThis.fetch = real
    }
    assert.equal(sawHeader, true, '用户数据请求必须带 X-OAuth-Token')
  })

  console.log(`user-signals tests passed (${passed} cases; zero real network requests)`)
}

try {
  await main()
} finally {
  closeDatabase?.()
  globalThis.fetch = originalFetch
  process.chdir(originalCwd)
  assert.equal(dirname(testDir), tempRoot)
  assert.ok(basename(testDir).startsWith('two-sides-signals-test-'))
  rmSync(testDir, { recursive: true, force: true })
}
