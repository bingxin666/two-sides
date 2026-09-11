<script setup lang="ts">
/**
 * 三条弹幕道（docs/02 §6.1）
 *  - 无缝 marquee：每条道渲染两份同样的卡片，track 位移 0 → -50%
 *    （每份 group 自带 28px 尾部内边距，-50% 恰好等于一份宽度 + 一个间距，接缝无跳动）
 *  - 三行不同速度（60s/75s/90s）与不同负延迟制造错落
 *  - 动画只走 transform（合成层），不碰 left；hover 暂停
 *  - 底部进度条（track 420×2 / thumb 150×2）用 rAF 读 Web Animations 的 currentTime
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { HotItem } from '@two-sides/contract'
import HotCard from './HotCard.vue'

const props = withDefaults(defineProps<{ items?: HotItem[] }>(), { items: () => [] })

const router = useRouter()

/** 弹幕道 y（相对光幕顶部；设计稿页面坐标 146/258/370，光幕自 y=100 起） */
const LANE_TOP = [46, 158, 270]
const LANE_DUR = ['60s', '75s', '90s']
const LANE_DELAY = ['-6s', '-28s', '-12s']
const TRACK_W = 420
const THUMB_W = 150

const thumbEl = ref<HTMLElement | null>(null)
const trackEls: HTMLElement[] = []
let raf = 0

function setTrack(el: unknown, i: number) {
  if (el) trackEls[i] = el as HTMLElement
}

const lanes = computed<HotItem[][]>(() => {
  const list = props.items ?? []
  return [0, 1, 2].map((n) => list.filter((_, i) => i % 3 === n))
})

function laneStyle(i: number) {
  return {
    top: `${LANE_TOP[i]}px`,
    animationDuration: LANE_DUR[i],
    animationDelay: LANE_DELAY[i],
  }
}

function open(qid: string) {
  router.push({ name: 'question', params: { qid } })
}

function tick() {
  const el = trackEls[0]
  const thumb = thumbEl.value
  if (el && thumb) {
    const anims = typeof el.getAnimations === 'function' ? el.getAnimations() : []
    const anim = anims[0]
    if (anim) {
      const t = Number(anim.currentTime ?? 0)
      const dur = Number(anim.effect?.getComputedTiming?.().duration ?? 0) || 60000
      const p = (((t % dur) + dur) % dur) / dur
      thumb.style.transform = `translateX(${(p * (TRACK_W - THUMB_W)).toFixed(2)}px)`
    }
  }
  raf = requestAnimationFrame(tick)
}

/** 数据是异步到达的，卡片真正出现后才启动进度条 rAF */
function startRaf() {
  if (raf || (props.items ?? []).length === 0) return
  raf = requestAnimationFrame(tick)
}

onMounted(startRaf)
watch(() => (props.items ?? []).length, startRaf)

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
})
</script>

<template>
  <div class="hot-grid">
    <template v-if="(items ?? []).length > 0">
      <div
        v-for="(lane, i) in lanes"
        :key="i"
        class="lane"
        :style="{ top: LANE_TOP[i] + 'px' }"
      >
        <div :ref="(el) => setTrack(el, i)" class="lane__track" :style="laneStyle(i)">
          <div class="lane__group">
            <HotCard v-for="it in lane" :key="it.qid" :item="it" @open="open" />
          </div>
          <div class="lane__group" aria-hidden="true">
            <HotCard
              v-for="it in lane"
              :key="`ghost-${it.qid}`"
              :item="it"
              tabindex="-1"
              @open="open"
            />
          </div>
        </div>
      </div>

      <div class="hot-grid__foot">
        <div class="scroll-hint">
          <span class="scroll-hint__arrow">←</span>
          <span>横向浏览今日热榜</span>
          <span class="scroll-hint__arrow">→</span>
        </div>
        <div class="progress" :style="{ width: `${TRACK_W}px` }">
          <div ref="thumbEl" class="progress__thumb" :style="{ width: `${THUMB_W}px` }" />
        </div>
      </div>
    </template>
    <p v-else class="hot-grid__empty">今日热榜尚未生成，可从下方直接粘贴知乎问题链接</p>
  </div>
</template>

<style scoped>
.hot-grid {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.lane {
  position: absolute;
  left: 0;
  right: 0;
  height: 112px;
  overflow: hidden;
}

.lane__track {
  display: flex;
  width: max-content;
  animation-name: marquee;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}

.lane__group {
  display: flex;
  gap: 28px;
  padding-right: 28px;
}

/* 卡片 hover 暂停该行 */
.lane:hover .lane__track {
  animation-play-state: paused;
}

@keyframes marquee {
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(-50%);
  }
}

.hot-grid__foot {
  position: absolute;
  left: var(--page-pad);
  right: var(--page-pad);
  bottom: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.scroll-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--muted);
}

.scroll-hint__arrow {
  font-size: 13px;
  color: var(--faint);
}

.progress {
  height: 2px;
  border-radius: 1px;
  background: rgba(28, 27, 25, .10);
  overflow: hidden;
}

.progress__thumb {
  height: 2px;
  border-radius: 1px;
  background: var(--ink-soft);
  will-change: transform;
}

.hot-grid__empty {
  position: absolute;
  left: var(--page-pad);
  top: 46px;
  font-size: 13px;
  color: var(--muted);
}

@media (max-width: 1024px) {
  .hot-grid__foot {
    left: 24px;
    right: 24px;
  }

  .progress {
    display: none;
  }
}
</style>
