<script setup lang="ts">
/**
 * 钉子轨道（设计稿 N2/N3）：钉子钉在光幕上——本组件是光幕覆盖层（absolute inset-0），
 * 渲染在 VeilGlass 插槽里，随光幕 600 ⇄ 300 一起收放。
 * 首屏 4 钉（x=48 起、钉距 24）；「还有 N 条」浮在光幕右上（top 136 · right 48），
 * 点击展开全部横向滑动查看，再点收起。接口一次给全、前端控制显隐。
 */
import { computed, ref } from 'vue'
import type { Judgment } from '@two-sides/contract'
import Pin from './Pin.vue'

const props = withDefaults(defineProps<{ judgments?: Judgment[]; selectedId?: string | null }>(), {
  judgments: () => [],
  selectedId: null,
})
const emit = defineEmits<{ (e: 'select', id: string): void }>()

const FIRST_SCREEN = 4
const showAll = ref(false)

const list = computed(() => props.judgments ?? [])
const visible = computed(() => (showAll.value ? list.value : list.value.slice(0, FIRST_SCREEN)))
const rest = computed(() => Math.max(0, list.value.length - FIRST_SCREEN))
</script>

<template>
  <div class="pin-rail">
    <div v-if="list.length > 0" class="pin-rail__list" :class="{ 'pin-rail__list--all': showAll }">
      <Pin
        v-for="j in visible"
        :key="j.id"
        :judgment="j"
        :selected="j.id === selectedId"
        @select="(id) => emit('select', id)"
      />
    </div>
    <p v-else class="pin-rail__empty">这个问题今天还没有可用的判断</p>

    <button
      v-if="rest > 0"
      type="button"
      class="pin-rail__more"
      @click="showAll = !showAll"
    >
      <span>{{ showAll ? '收起' : `还有 ${rest} 条` }}</span>
      <svg
        class="pin-rail__more-icon"
        :class="{ 'pin-rail__more-icon--up': showAll }"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
      >
        <path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" stroke-width="1.2"
          stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.pin-rail {
  position: absolute;
  inset: 0;
}

.pin-rail__list {
  display: flex;
  align-items: stretch;
  gap: 24px;
  height: 100%;
  padding: 0 var(--page-pad);
  overflow: hidden;
}

/* 展开全部后横向滑动查看；滚动条收敛，不破坏「一整块玻璃」 */
.pin-rail__list--all {
  overflow-x: auto;
  scrollbar-width: none;
}

.pin-rail__list--all::-webkit-scrollbar {
  display: none;
}

/* 「还有 N 条」：浮在光幕右上（设计稿 x≈1348 y=136），不是列表下方的文字链 */
.pin-rail__more {
  position: absolute;
  top: 136px;
  right: var(--page-pad);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 12px;
  line-height: 18px;
  color: var(--ink);
  transition: color .2s ease;
}

.pin-rail__more:hover {
  color: var(--ink-deep);
}

.pin-rail__more-icon {
  color: var(--ink-deep);
  transition: transform .2s ease;
}

.pin-rail__more-icon--up {
  transform: rotate(180deg);
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

  .pin-rail__more {
    right: 24px;
  }
}
</style>
