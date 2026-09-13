<script setup lang="ts">
/** 输入问题后提交一次搜索，自动进入首个匹配问题；输入过程中不展示候选。 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { getSearch } from '@/api'

const router = useRouter()
const text = ref('')
const loading = ref(false)
const error = ref('')
const MIN_CHARS = 2

async function submit() {
  const q = text.value.trim()
  if (q.length < MIN_CHARS) {
    error.value = `请输入至少 ${MIN_CHARS} 个字的问题`
    return
  }
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await getSearch(q)
    const first = result.items?.[0]
    if (!first) {
      error.value = '没有找到相关问题，请换个说法试试'
      return
    }
    await router.push({ name: 'question', params: { qid: first.qid }, query: { title: first.title } })
  } catch {
    error.value = '搜索暂时不可用，请稍后再试'
  } finally {
    loading.value = false
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
        <input v-model="text" class="search__input" type="text" placeholder="想点什么？" @keydown.enter.prevent="submit" />
      </div>
      <p v-if="error" class="search__error" role="alert">{{ error }}</p>
    </div>
    <button type="button" class="search__cta" :disabled="loading" @click="submit">{{ loading ? '搜索中…' : '看看分歧' }}</button>
  </div>
</template>

<style scoped>
.search { display: flex; align-items: flex-start; gap: 12px; flex: 1 1 auto; width: 100%; }
.search__field { flex: 1 1 auto; min-width: 0; }
.search__box { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 18px; border: 1px solid var(--line); border-radius: var(--radius-pill); background: #FFF; transition: border-color .2s ease; }
.search__box:focus-within { border-color: var(--ink-soft); }
.search__box--error { border-color: #B54747; }
.search__icon { flex: 0 0 auto; color: var(--muted); }
.search__input { flex: 1 1 auto; min-width: 0; border: 0; outline: none; background: transparent; font-family: var(--font-serif); font-size: 15px; color: var(--ink); }
.search__input::placeholder { color: var(--faint); }
.search__error { margin: 6px 18px 0; color: #B54747; font-size: 12px; }
.search__cta { flex: 0 0 auto; height: 52px; padding: 0 28px; border: 0; border-radius: var(--radius-pill); background: var(--ink); color: #FFF; font-family: var(--font-serif); font-weight: 500; font-size: 15px; transition: opacity .2s ease; }
.search__cta:hover:not(:disabled) { opacity: .88; }
.search__cta:disabled { opacity: .6; cursor: wait; }
@media (max-width: 1024px) { .search { flex-wrap: wrap; } .search__cta { margin-left: auto; } }
</style>
