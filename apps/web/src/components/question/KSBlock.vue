<script setup lang="ts">
/**
 * 看山解读（docs/02 §6）
 * 来源双态必须一眼可辨：zhida「知乎直答生成」（蓝） / fallback「AI 生成」（中性灰 + 正文上方说明行）
 * KSMark 仅用中性占位图形（光谱符号）——官方刘看山素材授权范围未确认，不改绘、不混拼。
 */
import { computed } from 'vue'
import type { SummarySource } from '@two-sides/contract'

const props = withDefaults(
  defineProps<{ summary?: string; source?: SummarySource }>(),
  { summary: '', source: undefined },
)

const isFallback = computed(() => props.source === 'fallback')
const badgeText = computed(() => (isFallback.value ? 'AI 生成' : '知乎直答生成'))
const hasBody = computed(() => (props.summary ?? '').trim().length > 0)
</script>

<template>
  <section class="ks">
    <header class="ks__head">
      <span class="ks__mark" aria-hidden="true"><span class="ks__mark-core" /></span>
      <h3 class="ks__title">看山解读</h3>
      <span class="ks__badge" :class="isFallback ? 'ks__badge--fallback' : 'ks__badge--zhida'">
        {{ badgeText }}
      </span>
    </header>

    <p v-if="isFallback && hasBody" class="ks__notice">本条由外部模型生成</p>

    <p v-if="hasBody" class="ks__body">{{ summary }}</p>
    <p v-else class="ks__body ks__body--empty">本条暂无可展示的综述。</p>
  </section>
</template>

<style scoped>
.ks__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ks__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: linear-gradient(90deg,
      var(--spectrum-1) 0%, var(--spectrum-2) 25%,
      var(--spectrum-3) 50%, var(--spectrum-4) 75%, var(--spectrum-5) 100%);
}

.ks__mark-core {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #FFF;
}

.ks__title {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 14px;
  line-height: 20px;
  color: var(--ink);
}

.ks__badge {
  padding: 1px 8px;
  border-radius: 9px;
  border: 1px solid transparent;
  font-family: var(--font-sans);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.ks__badge--zhida {
  border-color: var(--end-l);
  background: rgba(95, 162, 192, .12);
  color: #3E7E9C;
}

.ks__badge--fallback {
  border-color: var(--line);
  background: var(--tag-bg);
  color: var(--muted);
}

.ks__notice {
  margin-top: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

.ks__body {
  margin-top: 8px;
  font-family: var(--font-body);
  font-size: 13px;
  line-height: 22px;
  color: var(--ink-soft);
  transition: opacity .2s ease;
}

.ks__body--empty {
  color: var(--faint);
}
</style>
