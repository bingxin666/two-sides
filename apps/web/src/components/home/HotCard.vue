<script setup lang="ts">
/** 热榜问题卡：白 90% 玻璃卡，宽 300 · 圆角 10 · 内边距 20（docs/02 §3.3） */
import type { HotItem } from '@two-sides/contract'

const props = defineProps<{ item: HotItem }>()
const emit = defineEmits<{ (e: 'open', qid: string): void }>()
</script>

<template>
  <button
    type="button"
    class="hot-card"
    :title="props.item.title"
    @click="emit('open', props.item.qid)"
  >
    <span class="hot-card__title">{{ props.item.title }}</span>
  </button>
</template>

<style scoped>
.hot-card {
  flex: 0 0 auto;
  width: 300px;
  min-height: 88px;
  padding: 20px;
  border: 1px solid var(--card-line);
  border-radius: var(--radius-card);
  background: var(--card-glass);
  backdrop-filter: blur(2px);
  text-align: left;
  transition: transform .22s ease, box-shadow .22s ease, border-color .22s ease;
}

.hot-card:hover {
  transform: translateY(-2px);
  border-color: rgba(28, 28, 25, .18);
  box-shadow: 0 6px 18px rgba(28, 27, 25, .08);
}

.hot-card__title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 15px;
  line-height: 24px;
  color: var(--ink);
}

@media (max-width: 1024px) {
  .hot-card {
    width: 260px;
  }
}
</style>
