<script setup lang="ts">
/**
 * 知乎问题 URL 输入：提取 /question/<qid> 后仅将 qid 放入内部路由。
 * 查询参数、hash 及其他多余参数均会被丢弃；非知乎问题 URL 不提交。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const text = ref('')
const error = ref('')

/** 仅接受知乎问题页 URL，并返回规范化后的问题 id。 */
export function questionIdFromInput(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'zhihu.com' && !host.endsWith('.zhihu.com')) return null
  const match = /^\/question\/(\d{1,20})(?:\/|$)/.exec(parsed.pathname)
  return match?.[1] ?? null
}

function submit() {
  const qid = questionIdFromInput(text.value)
  if (!qid) {
    error.value = '请输入有效的知乎问题链接，例如 https://www.zhihu.com/question/123456789'
    return
  }
  error.value = ''
  router.push({ name: 'question', params: { qid } })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="search">
    <div class="search__field">
      <div class="search__box" :class="{ 'search__box--error': error }">
        <svg class="search__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M10.8 10.8 L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input
          v-model="text"
          class="search__input"
          type="url"
          inputmode="url"
          autocomplete="url"
          placeholder="粘贴知乎问题链接"
          aria-label="知乎问题链接"
          @keydown="onKeydown"
          @input="error = ''"
        />
      </div>
      <p v-if="error" class="search__error" role="alert">{{ error }}</p>
    </div>
    <button type="button" class="search__cta" @click="submit">看看分歧</button>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: 1 1 auto;
  width: 100%;
}

.search__field {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
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
  transition: border-color .2s ease;
}

.search__box:focus-within { border-color: var(--ink-soft); }
.search__box--error { border-color: #B54747; }
.search__icon { flex: 0 0 auto; color: var(--muted); }

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

.search__input::placeholder { color: var(--faint); }
.search__error { margin: 6px 18px 0; color: #B54747; font-size: 12px; }

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

.search__cta:hover { opacity: .88; }
</style>
