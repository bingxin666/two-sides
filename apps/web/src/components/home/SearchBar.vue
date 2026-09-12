<script setup lang="ts">
/**
 * 输入行（docs/02 §3.3 几何不变）：输入框 高52 · 圆角26 · 内边距18；CTA 高52 · 圆角26 · 内边距28
 * 纯文字搜索：输入即搜（debounce 350ms、≥4 字符触发 GET /search），候选下拉键盘可达。
 * 产品语义：输入框只有一种用法——打你想问的问题；qid 不对用户暴露，仅作内部路由参数。
 * 空结果 / 接口报错都如实提示，不假造候选。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { SearchCandidate } from '@two-sides/contract'
import { getSearch } from '@/api'

const router = useRouter()

const DEBOUNCE_MS = 350
const MIN_CHARS = 4

const text = ref('')
const items = ref<SearchCandidate[]>([])
const open = ref(false)
const loading = ref(false)
const error = ref('')
const shortHint = ref(false)
const active = ref(-1)
const fieldEl = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

function close() {
  open.value = false
  active.value = -1
}

async function runSearch() {
  const q = text.value.trim()
  const my = (seq += 1)
  if (q.length < MIN_CHARS) {
    items.value = []
    close()
    return
  }
  shortHint.value = false
  loading.value = true
  error.value = ''
  open.value = true
  try {
    const res = await getSearch(q)
    if (my !== seq) return // 过期响应丢弃（防抖期间连打）
    items.value = res.items ?? []
  } catch {
    if (my !== seq) return
    items.value = []
    error.value = '搜索暂时不可用，请稍后再试'
  } finally {
    if (my === seq) loading.value = false
  }
}

function onInput() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(runSearch, DEBOUNCE_MS)
}

/** CTA / 无候选时的 Enter：跳过防抖立即搜 */
function onCta() {
  if (timer) clearTimeout(timer)
  if (text.value.trim().length < MIN_CHARS) {
    shortHint.value = true
    error.value = ''
    items.value = []
    open.value = true
    return
  }
  void runSearch()
}

function pick(c: SearchCandidate) {
  close()
  router.push({ name: 'question', params: { qid: c.qid }, query: { title: c.title } })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    close()
    return
  }
  if (open.value && items.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      active.value = (active.value + 1) % items.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      active.value = active.value <= 0 ? items.value.length - 1 : active.value - 1
      return
    }
    if (e.key === 'Enter' && active.value >= 0) {
      e.preventDefault()
      pick(items.value[active.value])
      return
    }
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    onCta()
  }
}

function onDocClick(e: MouseEvent) {
  if (fieldEl.value && !fieldEl.value.contains(e.target as Node)) close()
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  if (timer) clearTimeout(timer)
  timer = undefined
})

watch(text, onInput)
watch(open, (v) => {
  if (!v) shortHint.value = false
})
</script>

<template>
  <div class="search">
    <div ref="fieldEl" class="search__field">
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
          role="combobox"
          :aria-expanded="open"
          aria-autocomplete="list"
          aria-controls="search-listbox"
          :aria-activedescendant="active >= 0 ? `search-opt-${active}` : undefined"
          @keydown="onKeydown"
        />
      </div>

      <ul v-if="open" id="search-listbox" class="search__drop" role="listbox">
        <li v-if="shortHint" class="search__note">输入至少 {{ MIN_CHARS }} 个字再搜索</li>
        <li v-else-if="loading" class="search__note">搜索中…</li>
        <li v-else-if="error" class="search__note">{{ error }}</li>
        <li v-else-if="items.length === 0" class="search__note">没有找到相关问题，换个说法试试</li>
        <template v-else>
          <li
            v-for="(c, i) in items"
            :id="`search-opt-${i}`"
            :key="c.qid"
            class="search__item"
            :class="{ 'search__item--active': i === active }"
            role="option"
            :aria-selected="i === active"
            @mouseenter="active = i"
            @mousedown.prevent="pick(c)"
          >
            {{ c.title }}
          </li>
        </template>
      </ul>
    </div>

    <button type="button" class="search__cta" @click="onCta">看看分歧</button>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  /* 撑满内容列：输入行与光幕/声明行同宽（1440 基准下输入框 ≈1200px），用户反馈"更长一些" */
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

/* 候选下拉：白底玻璃调性，贴 --line 描边，不喧宾夺主 */
.search__drop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 10;
  margin: 0;
  padding: 6px;
  list-style: none;
  background: #FFF;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: 0 12px 32px rgba(28, 27, 25, .10);
  overflow: hidden;
}

.search__item {
  padding: 10px 14px;
  border-radius: 8px;
  font-family: var(--font-serif);
  font-size: 14px;
  line-height: 22px;
  color: var(--ink);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search__item--active {
  background: var(--tag-bg);
}

.search__note {
  padding: 10px 14px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
  cursor: default;
}

@media (max-width: 1024px) {
  .search {
    flex-wrap: wrap;
  }
}
</style>
