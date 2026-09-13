<script setup lang="ts">
/** 热榜问题卡：白 90% 玻璃卡，宽 300 · 圆角 10 · 内边距 20（docs/02 §3.3） */
import type { HotItem } from '@two-sides/contract'

const props = withDefaults(
  defineProps<{ item: HotItem; mark?: string }>(),
  { mark: '' },
)
const emit = defineEmits<{ (e: 'open', qid: string): void }>()
</script>

<template>
  <button
    type="button"
    class="hot-card"
    :class="{ 'hot-card--marked': props.mark }"
    :title="props.item.title"
    @click="emit('open', props.item.qid)"
  >
    <span class="hot-card__title">{{ props.item.title }}</span>
    <!-- 「与你有关」标记：只在已登录且收藏命中时出现；无标记不代表「无关」 -->
    <span v-if="props.mark" class="hot-card__mark">
      <span class="hot-card__dot" aria-hidden="true" />
      {{ props.mark }}
    </span>
  </button>
</template>

<style scoped>
.hot-card {
  position: relative;
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

.hot-card--marked {
  border-color: rgba(28, 28, 25, .20);
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

/*
 * 标记：**绝对定位**在卡片下内边距区（标题最多 2 行 = 20+48=68，卡高 88）。
 * 刻意不进文档流：弹幕道只有 112px 高，进流会把卡片撑到 116px 被裁切；
 * 而且标记是热榜之后异步到达的，进流会让整条跑马灯重排抖动。
 * 无标记时该元素不渲染，卡片高度恒为 88，与设计稿一致。
 */
.hot-card__mark {
  position: absolute;
  right: 12px;
  bottom: 2px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: calc(100% - 24px);
  height: 18px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-family: var(--font-sans);
  font-size: 11px;
  line-height: 18px;
  color: var(--ink-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hot-card__dot {
  flex: 0 0 auto;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ink-soft);
}

@media (max-width: 1024px) {
  .hot-card {
    width: 260px;
  }
}
</style>
