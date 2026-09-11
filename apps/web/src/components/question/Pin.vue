<script setup lang="ts">
/**
 * 钉子（docs/02 §3.3）：宽 300 · 首个 x=48 · 间距 14
 * PinStem 宽 12（胶囊头 11×22 + 2px 竖线）；PinContent 上内边距 40、右内边距 14
 * 计数文案：N 人表态 = participantCount（人数），不是 sampleCount（条数）
 */
import { computed } from 'vue'
import type { Divergence, Judgment } from '@two-sides/contract'

const props = defineProps<{ judgment: Judgment; selected?: boolean }>()
const emit = defineEmits<{ (e: 'select', id: string): void }>()

const DIVERGENCE_LABEL: Record<Divergence, string> = {
  low: '低',
  mid: '中',
  high: '高',
  extreme: '极高',
}

const divergenceText = computed(() => DIVERGENCE_LABEL[props.judgment.divergence] ?? '—')
</script>

<template>
  <button
    type="button"
    class="pin"
    :class="{ 'pin--on': selected }"
    @click="emit('select', judgment.id)"
  >
    <span class="pin__stem" aria-hidden="true">
      <span class="pin__capsule" />
      <span class="pin__line" />
    </span>
    <span class="pin__content">
      <span class="pin__text">{{ judgment.text }}</span>
      <span class="pin__meta">
        <span class="pin__count">{{ judgment.participantCount }}</span>
        <span> 人表态 · 分歧度{{ divergenceText }}</span>
      </span>
    </span>
  </button>
</template>

<style scoped>
.pin {
  position: relative;
  flex: 0 0 auto;
  width: 300px;
  padding: 40px 14px 18px 24px;
  border-radius: 10px;
  text-align: left;
  transition: background .2s ease;
}

.pin:hover {
  background: rgba(242, 240, 234, .6);
}

.pin--on {
  background: var(--tag-bg);
}

.pin__stem {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.pin__capsule {
  width: 11px;
  height: 22px;
  border-radius: 5.5px;
  background: var(--ink-deep);
}

.pin__line {
  flex: 1 1 auto;
  width: 2px;
  min-height: 16px;
  margin-top: 4px;
  background: var(--ink-deep);
}

.pin__text {
  display: block;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 17px;
  line-height: 27px;
  color: var(--ink);
}

.pin__meta {
  display: block;
  margin-top: 10px;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

.pin__count {
  color: var(--ink-soft);
}

@media (max-width: 1024px) {
  .pin {
    scroll-snap-align: start;
  }
}
</style>
