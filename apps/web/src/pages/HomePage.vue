<script setup lang="ts">
/**
 * N1 首页（docs/02 §3.3 布局）：品牌行 h100 · 光幕 h600 · 声明行 h100
 * 2026-09-13 产品收敛：**没有输入行**。唯一入口是热榜「光幕」——点任意一条进问题页。
 * 热榜数据来自 GET /hot（只含已 ready），空态/缺数据如实提示，不白屏
 *
 * 增强层（可选，未配置/未登录时整层安静降级）：
 *   品牌行右侧「知乎授权登录」→ 后端 OAuth；登录后热榜卡上出现「与你有关」标记
 *   （你收藏过的题 / 你收藏过其中回答的题），N2 复用同一份标记。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { HotItem } from '@two-sides/contract'
import { getHot, goZhihuAuthorize } from '@/api'
import { ApiError } from '@/api/http'
import { useUserStore } from '@/stores/user'
import VeilGlass from '@/components/veil/VeilGlass.vue'
import HotGrid from '@/components/home/HotGrid.vue'
import HonestFooter from '@/components/home/HonestFooter.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const items = ref<HotItem[]>([])
const hotFailed = ref(false)
const hotLoading = ref(true)
const busy = ref(false)
let hotRetryTimer: ReturnType<typeof setTimeout> | undefined
let hotRequestInFlight = false
let disposed = false
const hotAbort = new AbortController()
const hotEmptyMessage = computed(() => {
  if (hotLoading.value && !hotFailed.value) return '正在读取今日知乎热榜…'
  if (hotFailed.value) return '热榜暂时未能连接，正在自动重试…'
  return '今日热榜分析尚未生成，准备好后将自动显示'
})

/**
 * 热榜由服务端每日后台预生成。首页可能先于预生成完成打开，
 * 因此定时重新读取真实接口，自动补进陆续 ready 的问题。
 */
async function loadHot(): Promise<void> {
  if (hotRequestInFlight || disposed) return
  hotRequestInFlight = true
  try {
    const res = await getHot({ signal: hotAbort.signal })
    if (disposed) return
    items.value = (res?.items ?? []).slice(0, 24)
    hotFailed.value = false
  } catch (error) {
    if (disposed) return
    // A 404 means no ready snapshot yet; the server continues generating it.
    hotFailed.value = !(error instanceof ApiError && error.status === 404)
  } finally {
    hotRequestInFlight = false
    hotLoading.value = false
    if (!disposed) {
      hotRetryTimer = setTimeout(() => { void loadHot() }, items.value.length === 0 ? 15_000 : 30_000)
    }
  }
}

/** 配置缺失或网络失败时的提示气泡 */
const loginHint = ref(false)
let hintTimer: ReturnType<typeof setTimeout> | undefined

/** qid → 标记文案（响应式：user.marks 变化即重算） */
const marks = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  if (!user.isLoggedIn) return out
  for (const qid of user.marks.keys()) {
    const label = user.labelFor(qid)
    if (label) out[qid] = label
  }
  return out
})

function showHint(text = '当前为离线预览，OAuth 登录需使用 live 后端') {
  loginHint.value = true
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { loginHint.value = false; hintTimer = undefined }, 2600)
}

function onLogin() {
  if (import.meta.env.VITE_API_MODE === 'mock') {
    // ?mock=authorized 可离线预览「已登录 + 有标记」的样子
    showHint('离线预览：加 ?mock=authorized 可模拟已登录')
    return
  }
  goZhihuAuthorize()
}

async function onLogout() {
  if (busy.value) return
  busy.value = true
  try {
    await user.signOut()
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  // OAuth 回跳：后端已种下会话 cookie，这里强制重拉标记并把 oauth 参数从地址栏摘掉
  const oauth = route.query.oauth
  if (oauth === 'success' || oauth === 'error') {
    if (oauth === 'error') showHint('知乎授权未完成，可重试')
    const query = { ...route.query }
    delete query.oauth
    void router.replace({ path: route.path, query })
  }

  const tasks: Promise<unknown>[] = []
  if (oauth === 'success') tasks.push(user.reloadAfterOauth())
  else tasks.push(user.ensureLoaded())

  tasks.push(loadHot())
  await Promise.all(tasks)
})

onBeforeUnmount(() => {
  disposed = true
  hotAbort.abort()
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = undefined
  if (hotRetryTimer) clearTimeout(hotRetryTimer)
  hotRetryTimer = undefined
})
</script>

<template>
  <div class="home">
    <header class="home__brand">
      <div class="home__brand-left">
        <h1 class="home__wordmark">两面</h1>
        <p class="home__tagline">一道判断的光谱</p>
      </div>
      <div class="home__login">
        <template v-if="user.isLoggedIn">
          <span class="home__login-state" role="status">
            <span class="home__login-dot" aria-hidden="true" />
            已登录知乎
          </span>
          <button type="button" class="home__login-btn" :disabled="busy" @click="onLogout">退出</button>
        </template>
        <button v-else type="button" class="home__login-btn" @click="onLogin">知乎授权登录</button>
        <p v-if="loginHint" class="home__login-hint" role="status">{{ loginHint }}</p>
      </div>
    </header>

    <div class="home__veil">
      <VeilGlass :height="600">
        <HotGrid :items="items" :marks="marks" :empty-message="hotEmptyMessage" />
      </VeilGlass>
      <p v-if="hotFailed && items.length > 0" class="home__hot-error">热榜更新暂时中断，正在自动重试…</p>
    </div>

    <div class="home__foot">
      <HonestFooter />
    </div>
  </div>
</template>

<style scoped>
.home {
  min-height: 100vh;
  padding-bottom: 24px;
}

.home__brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 100px;
  padding: 0 var(--page-pad);
}

.home__brand-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.home__wordmark {
  font-family: var(--font-serif);
  font-weight: 700;
  font-size: 26px;
  line-height: 36px;
  color: var(--ink);
}

.home__tagline {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 20px;
  color: var(--muted);
}

/* LoginBtn（设计稿）：描边胶囊 高36 · 圆角18 · 内边距16 */
.home__login {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}

/* 已登录态：小圆点 + 极简文字，与标记同一种视觉语言 */
.home__login-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--muted);
}

.home__login-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-soft);
}

.home__login-btn {
  height: 36px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 18px;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 13px;
  color: var(--ink-mid);
  transition: border-color .2s ease, color .2s ease, opacity .2s ease;
}

.home__login-btn:hover:not(:disabled) {
  border-color: var(--ink-soft);
  color: var(--ink);
}

.home__login-btn:disabled {
  opacity: .6;
  cursor: wait;
}

.home__login-hint {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: max-content;
  max-width: 260px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: #FFF;
  box-shadow: 0 8px 24px rgba(28, 27, 25, .08);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
  z-index: 10;
}

.home__veil {
  position: relative;
}

.home__hot-error {
  position: absolute;
  left: var(--page-pad);
  bottom: 96px;
  font-size: 12px;
  color: var(--muted);
}

.home__foot {
  display: flex;
  align-items: center;
  min-height: 100px;
  padding: 0 var(--page-pad);
}

@media (max-width: 1024px) {
  .home__brand,
  .home__foot {
    padding: 0 24px;
  }

  .home__hot-error {
    left: 24px;
  }
}
</style>
