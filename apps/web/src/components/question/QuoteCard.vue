<script setup lang="ts">
/**
 * 原话引用卡（docs/02 §6）
 * 回链规则：href 直接用接口给的 author.url（已带溯源 UTM），不改写、不去参、不自行拼接
 */
import type { AuthorRef } from '@two-sides/contract'

const props = withDefaults(
  defineProps<{ author: AuthorRef; preview?: boolean }>(),
  { preview: false },
)
</script>

<template>
  <figure class="quote" :class="{ 'quote--preview': preview }">
    <blockquote class="quote__text">{{ props.author.quote }}</blockquote>

    <figcaption class="quote__foot">
      <div class="quote__author">
        <span class="quote__name">{{ props.author.name }}</span>
        <span v-if="props.author.badge" class="quote__badge">{{ props.author.badge }}</span>
        <span class="quote__level">L{{ props.author.authority }}</span>
      </div>

      <p v-if="props.author.reason" class="quote__reason">归位理由：{{ props.author.reason }}</p>

      <a class="quote__link" :href="props.author.url" target="_blank" rel="noopener">
        <span>查看知乎原文</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 9 L9 3 M4.4 3 H9 V7.6" fill="none" stroke="currentColor" stroke-width="1.2"
            stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
    </figcaption>
  </figure>
</template>

<style scoped>
.quote {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--quote-bg);
  transition: opacity .18s ease;
}

/* hover 预览态：与「已选中」区分开 */
.quote--preview {
  opacity: .82;
}

.quote__text {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 14px;
  line-height: 24px;
  color: var(--ink);
}

.quote__foot {
  margin-top: 14px;
}

.quote__author {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--ink-soft);
}

.quote__name {
  font-weight: 500;
}

.quote__badge {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--tag-bg);
  color: var(--muted);
  font-size: 11px;
  line-height: 17px;
}

.quote__level {
  color: var(--muted);
}

.quote__reason {
  margin-top: 6px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

.quote__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 12px;
  color: var(--end-l);
}

.quote__link:hover {
  color: #3E7E9C;
}
</style>
