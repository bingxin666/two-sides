<script setup lang="ts">
/**
 * 钉子轨道（N2）：首屏 4 钉 + 「还有 N 条」，接口一次给全、前端控制显隐
 * 断点 1024：改为横向 snap 滑动列表
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
    <div v-if="list.length > 0" class="pin-rail__list">
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
      {{ showAll ? '收起' : `还有 ${rest} 条` }}
    </button>
  </div>
</template>

<style scoped>
.pin-rail__list {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.pin-rail__more {
  margin-top: 18px;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
  transition: color .2s ease, border-color .2s ease;
}

.pin-rail__more:hover {
  color: var(--ink);
  border-color: var(--ink-soft);
}

.pin-rail__empty {
  font-size: 13px;
  color: var(--muted);
}

@media (max-width: 1024px) {
  .pin-rail__list {
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding-bottom: 8px;
  }
}
</style>
