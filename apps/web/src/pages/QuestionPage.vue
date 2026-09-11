<script setup lang="ts">
/**
 * 问题页（docs/02 §2）：一个端点决定一切
 *   200 → N2 钉子列表；202 generating/pending → T1；202 failed → 失败卡片；展开 → N3（同路由）
 * 刷新用 URL query ?j=<judgmentId> 恢复展开态
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAnalysisStore } from '@/stores/analysis'
import VeilGlass from '@/components/veil/VeilGlass.vue'
import PinRail from '@/components/question/PinRail.vue'
import ExpandedPanel from '@/components/question/ExpandedPanel.vue'
import T1Progress from '@/components/status/T1Progress.vue'
import FailedCard from '@/components/status/FailedCard.vue'

const route = useRoute()
const router = useRouter()
const store = useAnalysisStore()
const { phase, analysis, progress, error, selectedJudgmentId } = storeToRefs(store)

const qid = computed(() => String(route.params.qid ?? ''))
const jFromQuery = computed(() => (typeof route.query.j === 'string' ? route.query.j : null))

const isGenerating = computed(() => phase.value === 'loading' || phase.value === 'generating')

const title = computed(() => {
  if (analysis.value?.question) return analysis.value.question
  if (phase.value === 'failed') return '这个问题今天没能生成'
  return '正在获取问题…'
})

const selectedJudgment = computed(
  () => analysis.value?.judgments.find((j) => j.id === selectedJudgmentId.value) ?? null,
)

const veilHeight = computed(() => (selectedJudgment.value ? 300 : 600))

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

function onClose() {
  store.select(null)
  syncQuery(null)
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
  if (qid.value) void store.retry(qid.value)
}

// 首屏加载；换题时重置再拉
onMounted(() => {
  if (qid.value) void store.load(qid.value)
})

watch(qid, (id, prev) => {
  if (!id || id === prev) return
  store.reset()
  void store.load(id)
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
      </p>
    </header>

    <VeilGlass :height="veilHeight" />

    <div class="qbody">
      <T1Progress v-if="isGenerating" :progress="progress" @cancel="onCancel" />

      <FailedCard v-else-if="phase === 'failed'" :error="error" @retry="onRetry" @back="goHome" />

      <PinRail
        v-else-if="analysis"
        :judgments="analysis.judgments"
        :selected-id="selectedJudgmentId"
        @select="onSelect"
      />

      <p v-else-if="phase === 'ready'" class="qbody__empty">这个问题今天还没有可用的判断</p>
    </div>

    <ExpandedPanel
      v-if="selectedJudgment"
      :key="selectedJudgment.id"
      :judgment="selectedJudgment"
      @close="onClose"
    />
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
  font-size: 12px;
  color: var(--muted);
}

.qhead__back:hover {
  color: var(--ink);
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
