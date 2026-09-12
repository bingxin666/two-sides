<script setup lang="ts">
/**
 * 看山解读（docs/02 §6）
 * 来源三态必须一眼可辨：
 *   zhida「知乎直答生成」（蓝） / liukanshan「刘看山解读 · AI 生成」（琥珀，当前主路径）
 *   / fallback「AI 生成」（中性灰 + 正文上方说明行）
 * 旧快照的 zhida / fallback 必须继续正常渲染（本地库有存量）。
 * KSMark 用官方刘看山头像（授权已确认：仅正常展示，不改绘、不混拼、不上品牌色）；
 * 16px 展示 + 32/64 供 2x/4x 高 DPI（MANIFEST.md 三档 LANCZOS 缩放）。
 */
import { computed } from 'vue'
import type { SummarySource } from '@two-sides/contract'

import ksmark16 from '@/assets/liukanshan/ksmark-16.png'
import ksmark32 from '@/assets/liukanshan/ksmark-32.png'
import ksmark64 from '@/assets/liukanshan/ksmark-64.png'

const props = withDefaults(
  defineProps<{ summary?: string; source?: SummarySource }>(),
  { summary: '', source: undefined },
)

const badgeText = computed(() => {
  if (props.source === 'liukanshan') return '刘看山解读 · AI 生成'
  if (props.source === 'fallback') return 'AI 生成'
  return '知乎直答生成'
})
const badgeKind = computed(() => props.source ?? 'zhida')
const hasBody = computed(() => (props.summary ?? '').trim().length > 0)
</script>

<template>
  <section class="ks">
    <header class="ks__head">
      <span class="ks__mark" aria-hidden="true">
        <img
          class="ks__mark-img"
          :src="ksmark16"
          :srcset="`${ksmark32} 2x, ${ksmark64} 4x`"
          width="16"
          height="16"
          alt=""
          decoding="async"
        />
      </span>
      <h3 class="ks__title">看山解读</h3>
      <!-- 没有内容就没有来源：缺综述时不渲染徽标，避免暗示有解读 -->
      <span v-if="hasBody" class="ks__badge" :class="`ks__badge--${badgeKind}`">
        {{ badgeText }}
      </span>
    </header>

    <p v-if="props.source === 'fallback' && hasBody" class="ks__notice">本条由外部模型生成</p>

    <p v-if="hasBody" class="ks__body">{{ summary }}</p>
    <p v-else class="ks__missing">本条暂无解读 · 生成未成功，可稍后重试</p>
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
}

.ks__mark-img {
  display: block;
  width: 16px;
  height: 16px;
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

/* 刘看山态：琥珀暖色一族，与蓝（zhida）/灰（fallback）一眼区分；
   文字用加深琥珀保证白底可读 */
.ks__badge--liukanshan {
  border-color: var(--end-r);
  background: rgba(213, 164, 117, .14);
  color: #A0723C;
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

/* 缺综述的诚实降级：比正文弱一档（--muted + 小一号字），不冒充有内容 */
.ks__missing {
  margin-top: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}
</style>
