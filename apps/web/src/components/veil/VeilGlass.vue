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

const props = withDefaults(defineProps<{ height?: number; panX?: number }>(), {
  height: 600,
  panX: 0,
})

const root = ref<HTMLElement | null>(null)
const strip = ref(0)
let ro: ResizeObserver | null = null

// The reference uses a fine curtain (roughly 50–70 slats on desktop).
// Keep the rhythm responsive while avoiding oversized bands on narrow screens.
const STRIP_MAX = 28
const STRIP_MIN = 14

function measure(width: number) {
  if (!width) return
  const desired = Math.min(STRIP_MAX, Math.max(STRIP_MIN, width * 0.018))
  const count = Math.min(96, Math.max(12, Math.round(width / desired)))
  strip.value = Math.max(12, Math.floor(width / count))
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
  const s: Record<string, string> = {
    height: `${props.height}px`,
    '--pan-x': `${props.panX}px`,
  }
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
  /* JS 未接管时的兜底：细密竖片，与设计稿的节奏一致 */
  --strip: clamp(14px, 1.8vw, 28px);
  transition: height .5s cubic-bezier(.22, .61, .36, 1);
  isolation: isolate;
  background: #f7f5f0;
  border-top: 1px solid rgba(255, 255, 255, .8);
  border-bottom: 1px solid rgba(255, 255, 255, .72);
  box-shadow: inset 0 18px 28px rgba(255, 255, 255, .18), inset 0 -22px 34px rgba(255, 255, 255, .24);
}

/* 层 1 · 光谱底：两端全饱和、中间消饱和 */
.veil__base {
  position: absolute;
  inset: 0 auto 0 0;
  width: max(100%, calc(100% + 1600px));
  opacity: .72;
  filter: saturate(1.08) contrast(.96);
  transform: translate3d(calc(var(--pan-x, 0px) * -.32), 0, 0);
  transition: transform .42s cubic-bezier(.22, .61, .36, 1);
  background: linear-gradient(90deg,
      #3C6B8A 0%, #5B7A8D 12.5%, #7A8A90 25%, #979D9A 37.5%,
      #B4B0A5 50%, #B8A585 62.5%, #BC9A67 75%, #B08750 87.5%, #A57439 100%);
}

/* 层 2 · 竖切：整数周期的白缝，切出一整块玻璃上的条 */
.veil__cut,
.veil__gloss {
  position: absolute;
  inset: 0 auto 0 0;
  width: max(100%, calc(100% + 1600px));
  pointer-events: none;
  transform: translate3d(calc(var(--pan-x, 0px) * -.32), 0, 0);
  transition: transform .42s cubic-bezier(.22, .61, .36, 1);
}

.veil__cut {
  background: repeating-linear-gradient(90deg,
      transparent 0,
      transparent calc(var(--strip) - 1px),
      rgba(255, 255, 255, .76) calc(var(--strip) - 1px),
      rgba(255, 255, 255, .76) var(--strip));
  filter: blur(.15px);
}

/* 层 3 · 高光边：每片玻璃左侧受光、右侧压深一点，制造厚度而不断裂 */
.veil__gloss {
  background: repeating-linear-gradient(90deg,
      rgba(255, 255, 255, .48) 0,
      rgba(255, 255, 255, .14) 2px,
      rgba(255, 255, 255, 0) 30%,
      rgba(255, 255, 255, 0) 76%,
      rgba(30, 32, 34, .11) calc(var(--strip) - 2px),
      rgba(30, 32, 34, .03) var(--strip));
}

/* 层 4 · TopSheen：上沿反光（600 高时约 78px） */
.veil::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: clamp(44px, 13%, 80px);
  background: linear-gradient(180deg, rgba(255, 255, 255, .5), rgba(255, 255, 255, .12) 46%, rgba(255, 255, 255, 0));
  pointer-events: none;
}

/* 层 5 · FadeLayer：上下融进白底 */
.veil::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg,
      rgba(255, 255, 255, .98) 0%, rgba(255, 255, 255, .18) 13%,
      rgba(255, 255, 255, 0) 28%, rgba(255, 255, 255, 0) 72%,
      rgba(255, 255, 255, .2) 87%, rgba(255, 255, 255, .98) 100%);
  pointer-events: none;
}

/* 内容层压在渐隐之上：热榜卡保持清晰，不被 FadeLayer 洗白 */
.veil__content {
  position: relative;
  z-index: 1;
  height: 100%;
}
</style>
