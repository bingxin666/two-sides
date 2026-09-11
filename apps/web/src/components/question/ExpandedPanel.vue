<script setup lang="ts">
/**
 * N3 详情区（docs/02 §6）：光幕 600→300 下移后，从下方交错 reveal
 * ExpandedHead → MiniSpectrum(+caption) → KSBlock → QuoteCard，依次延迟 60ms
 */
import { computed, ref } from 'vue'
import type { AuthorRef, Divergence, Judgment } from '@two-sides/contract'
import MiniSpectrum from '@/components/canvas/MiniSpectrum.vue'
import KSBlock from './KSBlock.vue'
import QuoteCard from './QuoteCard.vue'

const props = defineProps<{ judgment: Judgment }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const DIVERGENCE_LABEL: Record<Divergence, string> = {
  low: '低',
  mid: '中',
  high: '高',
  extreme: '极高',
}

interface PickedAuthor {
  key: string
  author: AuthorRef
}

const picked = ref<PickedAuthor[]>([])
const selected = ref<PickedAuthor | null>(null)
const hovered = ref<PickedAuthor | null>(null)

function onPicked(list: PickedAuthor[]) {
  picked.value = list
  if (list.length === 0) {
    selected.value = null
    return
  }
  const stillThere = selected.value && list.some((p) => p.key === selected.value!.key)
  if (stillThere) return
  selected.value = list.reduce(
    (m, p) => (p.author.authority > m.author.authority ? p : m),
    list[0],
  )
}

function onSelect(key: string, author: AuthorRef) {
  selected.value = { key, author }
}

function onHover(key: string | null, author: AuthorRef | null) {
  hovered.value = key && author ? { key, author } : null
}

const quoteAuthor = computed(() => hovered.value?.author ?? selected.value?.author ?? null)
const isPreview = computed(() => !!hovered.value && hovered.value.key !== selected.value?.key)

const captionMain = computed(() => {
  const j = props.judgment
  if (picked.value.length === 0) return `${j.participantCount} 人表态 · 暂无可归位的答主`
  return `${j.participantCount} 人表态 · 此处展示权威前 ${picked.value.length} 位 · 分歧度${DIVERGENCE_LABEL[j.divergence] ?? '—'}`
})
</script>

<template>
  <section class="expanded">
    <div class="expanded__head reveal" style="--d: 0ms">
      <div class="expanded__headline">
        <h2 class="expanded__title">{{ judgment.text }}</h2>
        <span v-if="selected" class="expanded__tag">已选中 · L{{ selected.author.authority }}</span>
      </div>
      <button type="button" class="expanded__close" @click="emit('close')">收起</button>
    </div>

    <div class="reveal" style="--d: 60ms">
      <MiniSpectrum
        :judgment="judgment"
        :selected-key="selected ? selected.key : null"
        @picked="onPicked"
        @select="onSelect"
        @hover="onHover"
      />
      <p class="caption">{{ captionMain }}</p>
      <p v-if="judgment.commentChallengeCount" class="caption caption--sub">
        另有 {{ judgment.commentChallengeCount }} 条精选评论提出不同看法
      </p>
    </div>

    <div class="reveal" style="--d: 120ms">
      <KSBlock :summary="judgment.summary" :source="judgment.summarySource" />
    </div>

    <div v-if="quoteAuthor" class="reveal" style="--d: 180ms">
      <QuoteCard :author="quoteAuthor" :preview="isPreview" />
    </div>
  </section>
</template>

<style scoped>
.expanded {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 32px 48px;
  background: #FFF;
}

.expanded__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.expanded__headline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.expanded__title {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 20px;
  line-height: 30px;
  color: var(--ink);
}

.expanded__tag {
  padding: 2px 10px;
  border-radius: 11px;
  background: var(--tag-bg);
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 12px;
  line-height: 18px;
  color: var(--ink-soft);
  white-space: nowrap;
}

.expanded__close {
  flex: 0 0 auto;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}

.expanded__close:hover {
  color: var(--ink);
}

.caption {
  margin-top: 10px;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

.caption--sub {
  margin-top: 4px;
  color: var(--faint);
}

/* N3 reveal：opacity + translateY(12px) 交错 */
@keyframes reveal {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.reveal {
  animation: reveal .5s cubic-bezier(.22, .61, .36, 1) both;
  animation-delay: var(--d, 0ms);
}

@media (max-width: 1024px) {
  .expanded {
    padding: 24px;
  }
}
</style>
