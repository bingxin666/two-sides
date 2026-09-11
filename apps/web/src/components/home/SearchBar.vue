<script setup lang="ts">
/**
 * 输入行（docs/02 §3.3）：输入框 高52 · 圆角26 · 内边距18；CTA 高52 · 圆角26 · 内边距28
 * 只做「链接 → qid」的解析，不猜关键词、不伪造结果；解析不出来就如实提示。
 */
import { ref } from 'vue'

const emit = defineEmits<{ (e: 'submit', qid: string): void }>()

const text = ref('')
const hint = ref('')

function extractQid(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(/question\/(\d+)/) ?? s.match(/\b(\d{6,})\b/)
  return m ? m[1] : null
}

function onSubmit() {
  const qid = extractQid(text.value)
  if (!qid) {
    hint.value = '暂时只支持知乎问题链接（形如 zhihu.com/question/数字）'
    return
  }
  hint.value = ''
  emit('submit', qid)
}
</script>

<template>
  <div class="search">
    <div class="search__box">
      <svg class="search__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M10.8 10.8 L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <input
        v-model="text"
        class="search__input"
        type="text"
        placeholder="想点什么？"
        @keyup.enter="onSubmit"
      />
    </div>
    <button type="button" class="search__cta" @click="onSubmit">看看分歧</button>
    <p v-if="hint" class="search__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
}

.search__box {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: #FFF;
  flex: 1 1 auto;
  min-width: 0;
  transition: border-color .2s ease;
}

.search__box:focus-within {
  border-color: var(--ink-soft);
}

.search__icon {
  flex: 0 0 auto;
  color: var(--muted);
}

.search__input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-family: var(--font-serif);
  font-size: 15px;
  color: var(--ink);
}

.search__input::placeholder {
  color: var(--faint);
}

.search__cta {
  flex: 0 0 auto;
  height: 52px;
  padding: 0 28px;
  border-radius: var(--radius-pill);
  background: var(--ink);
  color: #FFF;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 15px;
  transition: opacity .2s ease;
}

.search__cta:hover {
  opacity: .88;
}

.search__hint {
  position: absolute;
  left: 18px;
  top: 58px;
  font-size: 12px;
  color: var(--muted);
}

@media (max-width: 1024px) {
  .search {
    flex-wrap: wrap;
  }
}
</style>
