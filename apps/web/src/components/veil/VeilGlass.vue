<script setup lang="ts">
/**
 * 玻璃光幕 · 五层结构（docs/02 §4），纯 CSS 实现
 *  1 GradientBase 光谱底  2 CutMask 竖切  3 GlossEdges 高光边
 *  4 TopSheen 上沿反光    5 FadeLayer 上下渐隐
 *
 * 条数自适应：CSS 兜底用 min(118px, 12vw)；JS 接管后把条宽量化为「整数 CSS 像素」——
 * 周期是整数，每条缝隙都落在同一亚像素相位上，不会出现逐条宽度抖动 / 摩尔纹，
 * 条数 = Math.round(容器宽 / 目标条宽) 随屏宽自然增减（1440→12 条，768→8 条，375→6 条）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ height?: number }>(), { height: 600 })

const root = ref<HTMLElement | null>(null)
const strip = ref(0)
let ro: ResizeObserver | null = null

const STRIP_MAX = 118
const STRIP_MIN = 64

function measure(width: number) {
  if (!width) return
  const desired = Math.min(STRIP_MAX, Math.max(STRIP_MIN, width * 0.12))
  const count = Math.min(24, Math.max(3, Math.round(width / desired)))
  strip.value = Math.max(32, Math.floor(width / count))
}

onMounted(() => {
  const el = root.value
  if (!el) return
  measure(el.clientWidth)
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((entries) => {
    for (const entry of entries) measure(entry.contentRect.width)
  })
  ro.observe(el)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

const style = computed<Record<string, string>>(() => {
  const s: Record<string, string> = { height: `${props.height}px` }
  if (strip.value > 0) s['--strip'] = `${strip.value}px`
  return s
})
</script>

<template>
  <div ref="root" class="veil" :style="style">
    <div class="veil__base" />
    <div class="veil__cut" />
    <div class="veil__gloss" />
    <div class="veil__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.veil {
  position: relative;
  width: 100%;
  overflow: hidden;
  /* JS 未接管时的兜底（设计稿线索：min(118px, 12vw)） */
  --strip: min(118px, 12vw);
  transition: height .5s cubic-bezier(.22, .61, .36, 1);
  isolation: isolate;
}

/* 层 1 · 光谱底：两端全饱和、中间消饱和 */
.veil__base {
  position: absolute;
  inset: 0;
  opacity: .58;
  background: linear-gradient(90deg,
      #3C6B8A 0%, #5B7A8D 12.5%, #7A8A90 25%, #979D9A 37.5%,
      #B4B0A5 50%, #B8A585 62.5%, #BC9A67 75%, #B08750 87.5%, #A57439 100%);
}

/* 层 2 · 竖切：整数周期的白缝，切出一整块玻璃上的条 */
.veil__cut,
.veil__gloss {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.veil__cut {
  background: repeating-linear-gradient(90deg,
      transparent 0,
      transparent calc(var(--strip) - 2px),
      rgba(255, 255, 255, .92) calc(var(--strip) - 2px),
      rgba(255, 255, 255, .92) var(--strip));
}

/* 层 3 · 高光边：每片玻璃左侧受光、右侧压深一点，制造厚度而不断裂 */
.veil__gloss {
  background: repeating-linear-gradient(90deg,
      rgba(255, 255, 255, .40) 0,
      rgba(255, 255, 255, .10) 2px,
      rgba(255, 255, 255, 0) 12px,
      rgba(255, 255, 255, 0) calc(var(--strip) - 14px),
      rgba(28, 27, 25, .05) calc(var(--strip) - 3px),
      rgba(28, 27, 25, .05) calc(var(--strip) - 2px));
}

/* 层 4 · TopSheen：上沿反光（600 高时约 78px） */
.veil::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 13%;
  background: linear-gradient(180deg, rgba(255, 255, 255, .34), rgba(255, 255, 255, 0));
  pointer-events: none;
}

/* 层 5 · FadeLayer：上下融进白底 */
.veil::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg,
      #FFF 0%, rgba(255, 255, 255, 0) 34%,
      rgba(255, 255, 255, 0) 66%, #FFF 100%);
  pointer-events: none;
}

/* 内容层压在渐隐之上：热榜卡保持清晰，不被 FadeLayer 洗白 */
.veil__content {
  position: relative;
  z-index: 1;
  height: 100%;
}
</style>
