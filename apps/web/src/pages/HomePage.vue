<script setup lang="ts">
/**
 * N1 首页（docs/02 §3.3 布局）：品牌行 h100 · 光幕 h600 · 输入行 h100 · 声明行 h100
 * 热榜数据来自 GET /hot（只含已 ready），空态/缺数据如实提示，不白屏
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { HotItem } from '@two-sides/contract'
import { getHot } from '@/api'
import VeilGlass from '@/components/veil/VeilGlass.vue'
import HotGrid from '@/components/home/HotGrid.vue'
import SearchBar from '@/components/home/SearchBar.vue'
import HonestFooter from '@/components/home/HonestFooter.vue'

const router = useRouter()

const items = ref<HotItem[]>([])
const hotFailed = ref(false)

onMounted(async () => {
  try {
    const res = await getHot()
    // 接口给 30 条，首页取 24
    items.value = (res?.items ?? []).slice(0, 24)
  } catch {
    hotFailed.value = true
  }
})

function onSubmit(qid: string) {
  router.push({ name: 'question', params: { qid } })
}
</script>

<template>
  <div class="home">
    <header class="home__brand">
      <h1 class="home__wordmark">两面</h1>
      <p class="home__tagline">同一个问题，看见两侧的分布</p>
    </header>

    <div class="home__veil">
      <VeilGlass :height="600">
        <HotGrid :items="items" />
      </VeilGlass>
      <p v-if="hotFailed" class="home__hot-error">热榜暂时取不到，可直接在下方粘贴问题链接</p>
    </div>

    <div class="home__search">
      <SearchBar @submit="onSubmit" />
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
  gap: 16px;
  height: 100px;
  padding: 0 var(--page-pad);
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
