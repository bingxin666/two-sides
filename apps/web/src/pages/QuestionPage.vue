<script setup lang="ts">
/**
 * 问题页（docs/02 §2）：一个端点决定一切
 *   200 → N2 钉子列表；202 generating/pending → T1；202 failed → 失败卡片；展开 → N3（同路由）
 * 刷新用 URL query ?j=<judgmentId> 恢复展开态
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAnalysisStore } from '@/stores/analysis'
import VeilGlass from '@/components/veil/VeilGlass.vue'
import PinRail from '@/components/question/PinRail.vue'
import T1Progress from '@/components/status/T1Progress.vue'
import FailedCard from '@/components/status/FailedCard.vue'

const route = useRoute()
const router = useRouter()
const store = useAnalysisStore()
const { phase, analysis, progress, error, selectedJudgmentId } = storeToRefs(store)

const qid = computed(() => String(route.params.qid ?? ''))
const jFromQuery = computed(() => (typeof route.query.j === 'string' ? route.query.j : null))
/** 搜索候选带来的标题提示：冷题懒生成时给服务端当 title 提示（契约 ENDPOINTS.analysis） */
const titleFromQuery = computed(() => {
  const t = route.query.title
  return typeof t === 'string' && t.trim() ? t : undefined
})

const isGenerating = computed(() => phase.value === 'loading' || phase.value === 'generating')

const title = computed(() => {
  if (analysis.value?.question) return analysis.value.question
  // 生成期间搜索候选已带来标题：如实用它，不让用户看占位文案
  if (isGenerating.value && titleFromQuery.value) return titleFromQuery.value
  if (phase.value === 'failed') return '这个问题今天没能生成'
  return '正在获取问题…'
})

/**
 * 薄样本救援合并的透明标注（契约 mergedQuestions，optional 防御）：
 * sampleCount 含合并样本，声明行必须同步说明；hover 列出来源提问，避免静默合并
 */
const mergedQuestions = computed(() => analysis.value?.mergedQuestions ?? [])
const mergedCount = computed(() => mergedQuestions.value.length)
const mergedTitles = computed(() =>
  mergedQuestions.value
    .map((m) => `· ${m.title}（${m.reason === 'same_title' ? '同题重定向' : '相关提问'}）`)
    .join('\n'),
)

/** T1 总进度 0..1：四阶段均分 + 当前阶段内部推进比（驱动光幕上的 RevealMask） */
const STAGE_ORDER = ['extract', 'merge', 'orient', 'render']
const genTotal = computed(() => {
  const p = progress.value
  const idx = Math.max(0, STAGE_ORDER.indexOf(p?.stage ?? 'extract'))
  const ratio = Math.min(1, Math.max(0, p?.stageRatio ?? 0))
  return Math.min(1, (idx + ratio) / STAGE_ORDER.length)
})

function syncQuery(id: string | null) {
  const query = { ...route.query }
  if (id) query.j = id
  else delete query.j
  router.replace({ name: 'question', params: { qid: qid.value }, query })
}

function onSelect(id: string) {
  const next = selectedJudgmentId.value === id ? null : id
  store.select(next)
  syncQuery(next)
}

function goHome() {
  router.push({ name: 'home' })
}

/** T1「取消」：停掉本轮轮询再回首页（后端任务不中断） */
function onCancel() {
  store.cancelPolling()
  goHome()
}

function onRetry() {
  if (!qid.value) return
  // 懒生成失败后的重试同样带上 title 提示，避免二次生成降级到无提示路径
  void store.retry(qid.value, titleFromQuery.value ? { title: titleFromQuery.value } : undefined)
}

// 首屏加载；换题时重置再拉。title 提示随 query 透传给懒生成
onMounted(() => {
  if (qid.value) void store.load(qid.value, titleFromQuery.value ? { title: titleFromQuery.value } : undefined)
})

// 离开页面即停本轮轮询（后端任务不中断，§6.3）
onUnmounted(() => {
  store.cancelPolling()
})

watch(qid, (id, prev) => {
  if (!id || id === prev) return
  store.reset()
  void store.load(id, titleFromQuery.value ? { title: titleFromQuery.value } : undefined)
})

// ?j= 恢复展开态
watch(
  [analysis, jFromQuery],
  () => {
    const jid = jFromQuery.value
    if (!jid || !analysis.value) return
    if (selectedJudgmentId.value === jid) return
    if (analysis.value.judgments.some((j) => j.id === jid)) store.select(jid)
  },
  { immediate: true },
)
</script>

<template>
  <div class="qpage">
    <header class="qhead">
      <button type="button" class="qhead__back" @click="goHome">← 返回首页</button>
      <h1 class="qhead__title">{{ title }}</h1>
      <p v-if="analysis" class="qhead__meta">
        基于 {{ analysis.sampleCount }} 条回答 · {{ analysis.date }}
        <span
          v-if="mergedCount > 0"
          class="qhead__merged"
          :title="`样本合并自以下提问：\n${mergedTitles}`"
        >（含 {{ mergedCount }} 个相关提问的回答）</span>
      </p>
    </header>

    <VeilGlass :height="600">
      <!-- 判断以横向轨道呈现；详情不再展开到光幕下方 -->
      <PinRail
        v-if="analysis && !isGenerating"
        :judgments="analysis.judgments"
        :selected-id="selectedJudgmentId"
        @select="onSelect"
      />
      <!-- T1：光谱生成中 = 光幕从左向右被揭示（设计稿 RevealMask 盖在光幕上） -->
      <div
        v-else-if="isGenerating"
        class="qveil__mask"
        :style="{ width: `${(1 - genTotal) * 100}%` }"
        aria-hidden="true"
      />
    </VeilGlass>

    <div v-if="isGenerating || phase === 'failed' || !analysis" class="qbody">
      <T1Progress v-if="isGenerating" :progress="progress" @cancel="onCancel" />

      <FailedCard v-else-if="phase === 'failed'" :error="error" @retry="onRetry" @back="goHome" />

      <p v-else-if="phase === 'ready'" class="qbody__empty">这个问题今天还没有可用的判断</p>
    </div>

  </div>
</template>

<style scoped>
.qpage {
  min-height: 100vh;
  padding-bottom: 48px;
}

.qhead {
  padding: 36px var(--page-pad);
}

.qhead__back {
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 13px;
  color: var(--muted);
}

.qhead__back:hover {
  color: var(--ink);
}

/* T1 揭示遮罩：右侧白 → 左侧透明，宽度随总进度收窄，盖在光幕上 */
.qveil__mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(270deg, #FFF 0%, rgba(255, 255, 255, .85) 55%, rgba(255, 255, 255, 0) 100%);
  pointer-events: none;
  transition: width .4s linear;
}

.qhead__title {
  margin-top: 20px;
  max-width: 1040px;
  font-family: var(--font-serif);
  font-weight: 700;
  font-size: 34px;
  line-height: 48px;
  color: var(--ink);
}

.qhead__meta {
  margin-top: 10px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

/* 合并声明：与 meta 同级弱化，不抢「基于 N 条回答」主信息；hover tooltip 列出来源 */
.qhead__merged {
  color: var(--muted);
}

.qbody {
  padding: 32px var(--page-pad) 0;
}

.qbody__empty {
  font-size: 13px;
  color: var(--muted);
}

@media (max-width: 1024px) {
  .qhead {
    padding: 24px;
  }

  .qhead__title {
    font-size: 26px;
    line-height: 38px;
  }

  .qbody {
    padding: 24px 24px 0;
  }
}
</style>
