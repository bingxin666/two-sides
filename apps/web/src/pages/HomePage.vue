<script setup lang="ts">
/**
 * N1 首页（docs/02 §3.3 布局）：品牌行 h100 · 光幕 h600 · 输入行 h100 · 声明行 h100
 * 热榜数据来自 GET /hot（只含已 ready），空态/缺数据如实提示，不白屏
 * 品牌行右侧「知乎授权登录」（设计稿 LoginBtn）：增强层（OAuth）条件模块，凭证未获批——
 * 点击如实告知，不假装能登录（docs/02 §8 诚实设计）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { HotItem } from '@two-sides/contract'
import { getHot } from '@/api'
import VeilGlass from '@/components/veil/VeilGlass.vue'
import HotGrid from '@/components/home/HotGrid.vue'
import SearchBar from '@/components/home/SearchBar.vue'
import HonestFooter from '@/components/home/HonestFooter.vue'

const items = ref<HotItem[]>([])
const hotFailed = ref(false)

/** 登录提示气泡：点击后短暂出现，自动消失 */
const loginHint = ref(false)
let hintTimer: ReturnType<typeof setTimeout> | undefined

function onLogin() {
  loginHint.value = true
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    loginHint.value = false
    hintTimer = undefined
  }, 2600)
}

onMounted(async () => {
  try {
    const res = await getHot()
    // 接口给 30 条，首页取 24
    items.value = (res?.items ?? []).slice(0, 24)
  } catch {
    hotFailed.value = true
  }
})

onBeforeUnmount(() => {
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = undefined
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
        <button type="button" class="home__login-btn" @click="onLogin">知乎授权登录</button>
        <p v-if="loginHint" class="home__login-hint" role="status">
          知乎授权登录属增强层能力，OAuth 凭证获批后开放
        </p>
      </div>
    </header>

    <div class="home__veil">
      <VeilGlass :height="600">
        <HotGrid :items="items" />
      </VeilGlass>
      <p v-if="hotFailed" class="home__hot-error">热榜暂时取不到，可直接在下方粘贴问题链接</p>
    </div>

    <div class="home__search">
      <SearchBar />
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
  flex: 0 0 auto;
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
  transition: border-color .2s ease, color .2s ease;
}

.home__login-btn:hover {
  border-color: var(--ink-soft);
  color: var(--ink);
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

.home__search {
  display: flex;
  align-items: center;
  height: 100px;
  padding: 0 var(--page-pad);
}

.home__foot {
  display: flex;
  align-items: center;
  min-height: 100px;
  padding: 0 var(--page-pad);
}

@media (max-width: 1024px) {
  .home__brand,
  .home__search,
  .home__foot {
    padding: 0 24px;
  }

  .home__hot-error {
    left: 24px;
  }
}
</style>
