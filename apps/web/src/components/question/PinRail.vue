<script setup lang="ts">
/**
 * 钉子轨道（设计稿 N2/N3）：钉子钉在光幕上——本组件是光幕覆盖层（absolute inset-0），
 * 渲染在 VeilGlass 插槽里，随光幕 600 ⇄ 300 一起收放。
 * 所有钉子在同一条横向轨道中；左右边缘是隐形热区，鼠标靠近时才显出导航按钮。
 */
import { computed, onMounted, ref } from 'vue'
import type { Judgment } from '@two-sides/contract'
import Pin from './Pin.vue'

const props = withDefaults(defineProps<{ judgments?: Judgment[]; selectedId?: string | null }>(), {
  judgments: () => [],
  selectedId: null,
})
const emit = defineEmits<{ (e: 'select', id: string): void }>()

const list = computed(() => props.judgments ?? [])
const railEl = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
const edgeHover = ref<'left' | 'right' | null>(null)

function syncArrows() {
  const el = railEl.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 4
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}

function scrollByPage(direction: number) {
  const el = railEl.value
  if (!el) return
  el.scrollBy({ left: direction * Math.max(240, el.clientWidth * 0.72), behavior: 'smooth' })
  window.setTimeout(syncArrows, 320)
}

onMounted(syncArrows)
</script>

<template>
  <div class="pin-rail" @mouseenter="syncArrows">
    <div v-if="list.length > 0" ref="railEl" class="pin-rail__list" @scroll="syncArrows">
      <Pin
        v-for="j in list"
        :key="j.id"
        :judgment="j"
        :selected="j.id === selectedId"
        @select="(id) => emit('select', id)"
      />
    </div>
    <p v-else class="pin-rail__empty">这个问题今天还没有可用的判断</p>

    <div
      v-if="canScrollLeft"
      class="pin-rail__edge pin-rail__edge--left"
      @mouseenter="edgeHover = 'left'"
      @mouseleave="edgeHover = null"
    >
      <button
        type="button"
        class="pin-rail__arrow"
        :class="{ 'pin-rail__arrow--visible': edgeHover === 'left' }"
        aria-label="向左查看更多判断"
        @click="scrollByPage(-1)"
      >←</button>
    </div>
    <div
      v-if="canScrollRight"
      class="pin-rail__edge pin-rail__edge--right"
      @mouseenter="edgeHover = 'right'"
      @mouseleave="edgeHover = null"
    >
      <button
        type="button"
        class="pin-rail__arrow"
        :class="{ 'pin-rail__arrow--visible': edgeHover === 'right' }"
        aria-label="向右查看更多判断"
        @click="scrollByPage(1)"
      >→</button>
    </div>
  </div>
</template>

<style scoped>
.pin-rail {
  position: absolute;
  inset: 0;
  --rail-pad: var(--page-pad);
}

.pin-rail__list {
  display: flex;
  align-items: stretch;
  gap: 24px;
  height: 100%;
  padding: 0 var(--rail-pad);
  overflow-x: auto;
  scroll-behavior: smooth;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.pin-rail__list--all::-webkit-scrollbar {
  display: none;
}

/* 细长的玻璃导航片：按钮本身保持透明，让后面的光幕继续可见。 */
.pin-rail__arrow {
  z-index: 2;
  display: grid;
  place-items: center;
  width: 28px;
  height: 104px;
  border: 1px solid rgba(255, 255, 255, .48);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, .28), rgba(255, 255, 255, .12));
  -webkit-backdrop-filter: blur(10px) saturate(1.15);
  backdrop-filter: blur(10px) saturate(1.15);
  box-shadow: inset 0 0 0 1px rgba(28, 27, 25, .06), 0 8px 22px rgba(28, 27, 25, .10);
  opacity: 0;
  transform: scale(.92);
  pointer-events: none;
  font-size: 22px;
  line-height: 1;
  font-weight: 300;
  color: rgba(28, 27, 25, .72);
  transition: opacity .18s ease, background .2s ease, transform .18s ease;
}

.pin-rail__edge {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 88px;
  display: grid;
  place-items: center;
}

.pin-rail__edge--left {
  left: 0;
  background: linear-gradient(90deg, rgba(255,255,255,.26), transparent);
}

.pin-rail__edge--right {
  right: 0;
  background: linear-gradient(270deg, rgba(255,255,255,.26), transparent);
}

.pin-rail__arrow--visible {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

.pin-rail__arrow:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, .44), rgba(255, 255, 255, .2));
  transform: scale(1.05);
}

.pin-rail__empty {
  position: absolute;
  left: var(--page-pad);
  top: 40px;
  font-size: 13px;
  color: var(--muted);
}

@media (max-width: 1024px) {
  .pin-rail__list {
    padding: 0 24px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }

  .pin-rail__list::-webkit-scrollbar {
    display: none;
  }

  .pin-rail__edge {
    width: 72px;
  }

  .pin-rail__arrow {
    width: 26px;
    height: 84px;
  }
}
</style>
