<script setup lang="ts">
/**
 * 迷你光谱带（docs/02 §5）· Canvas 绘制
 *  - 底带：8px 圆角五档渐变（§3.1）
 *  - 圆点：普通 10px / 选中 14px + 2px 白描边；空档不画点
 *  - DPR：backing store 按 devicePixelRatio 缩放，Retina 不糊
 *  - 命中：记录每个圆点 (x, y)，click/hover 取「离指针最近且距离 ≤12px」的点（圆点会重叠，
 *    取最近中心比取最后绘制的更准），命中后 emit 给父级联动 QuoteCard
 *  - 仅在展开态存在：组件销毁即断开 ResizeObserver 与 rAF
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AuthorRef, Judgment, Slot } from '@two-sides/contract'

const props = withDefaults(
  defineProps<{
    judgment: Judgment
    /** 选中圆点 key（父级管理选中态） */
    selectedKey?: string | null
    /** 最多画几个点（设计稿：权威前 5 位） */
    maxDots?: number
  }>(),
  { selectedKey: null, maxDots: 5 },
)

interface Picked {
  key: string
  slot: Slot
  author: AuthorRef
}

const emit = defineEmits<{
  (e: 'select', key: string, author: AuthorRef, slot: Slot): void
  (e: 'hover', key: string | null, author: AuthorRef | null): void
  /** 实际落点的答主（父级据此取默认选中与「前 N 位」文案） */
  (e: 'picked', list: Picked[]): void
}>()

const CANVAS_H = 30
const BAND_H = 8
const PAD = 12

interface Dot {
  key: string
  cx: number
  cy: number
  author: AuthorRef
  slot: Slot
  selected: boolean
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const hoverKey = ref<string | null>(null)

let dots: Dot[] = []
let ro: ResizeObserver | null = null
let rafId = 0

const keyOf = (slot: Slot, name: string) => `${slot}|${name}`
/** 权威级优先、同级看赞同数 */
const rank = (a: AuthorRef) => a.authority * 1e9 + Math.min(a.voteUp, 1e8)

/**
 * 先每档取权威最高者（保证圆点铺开、不挤在一档），再按权威补齐到 maxDots。
 * participantCount 可能远大于 5，光谱只呈现权威前几位，文案由父级如实说明。
 */
const picked = computed<Picked[]>(() => {
  const buckets = [...props.judgment.distribution]
    .filter((b) => b.authors.length > 0)
    .sort((a, b) => a.slot - b.slot)

  const first: Picked[] = []
  const seen = new Set<string>()
  for (const b of buckets) {
    const top = b.authors.reduce((m, a) => (rank(a) > rank(m) ? a : m), b.authors[0])
    const key = keyOf(b.slot, top.name)
    first.push({ key, slot: b.slot, author: top })
    seen.add(key)
  }
  if (first.length >= props.maxDots) return first.slice(0, props.maxDots)

  const rest: Picked[] = []
  for (const b of buckets) {
    for (const a of b.authors) {
      const key = keyOf(b.slot, a.name)
      if (!seen.has(key)) rest.push({ key, slot: b.slot, author: a })
    }
  }
  rest.sort((p, q) => rank(q.author) - rank(p.author))
  return first.concat(rest).slice(0, props.maxDots)
})

const ariaLabel = computed(() => {
  const j = props.judgment
  return `取向光谱：${j.semanticAxis.left} 到 ${j.semanticAxis.right}，共 ${j.participantCount} 人表态，当前展示 ${picked.value.length} 位答主`
})

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

function draw() {
  const cv = canvasEl.value
  if (!cv) return
  const cssW = cv.clientWidth
  if (!cssW) return

  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  const bw = Math.round(cssW * dpr)
  const bh = Math.round(CANVAS_H * dpr)
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw
    cv.height = bh
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, CANVAS_H)

  const cy = Math.round(CANVAS_H / 2)
  const x0 = PAD
  const x1 = cssW - PAD
  const slotW = (x1 - x0) / 5

  // 底带
  const grad = ctx.createLinearGradient(x0, 0, x1, 0)
  grad.addColorStop(0, '#2E80A8')
  grad.addColorStop(0.25, '#5EA3BF')
  grad.addColorStop(0.5, '#C7C2B0')
  grad.addColorStop(0.75, '#D6A475')
  grad.addColorStop(1, '#BA8A42')
  ctx.fillStyle = grad
  roundRect(ctx, x0, cy - BAND_H / 2, x1 - x0, BAND_H, BAND_H / 2)
  ctx.fill()

  // 圆点：同档多人横向微散开（总跨度 ≤12px，即 ±6px）
  const groups = new Map<Slot, Picked[]>()
  for (const p of picked.value) {
    const list = groups.get(p.slot)
    if (list) list.push(p)
    else groups.set(p.slot, [p])
  }

  dots = []
  const plain: Dot[] = []
  const onTop: Dot[] = []
  for (const [slot, list] of groups) {
    const cx0 = x0 + (slot - 0.5) * slotW
    const span = Math.min(12, Math.max(0, slotW - 24))
    const step = list.length > 1 ? span / (list.length - 1) : 0
    list.forEach((p, i) => {
      const selected = p.key === props.selectedKey
      const d: Dot = {
        key: p.key,
        cx: cx0 - span / 2 + i * step,
        cy,
        author: p.author,
        slot,
        selected,
      }
      ;(selected ? onTop : plain).push(d)
    })
  }
  dots = plain.concat(onTop)

  for (const d of dots) {
    const hovered = d.key === hoverKey.value
    const r = (d.selected ? 7 : 5) + (hovered ? 1.5 : 0)
    ctx.beginPath()
    ctx.arc(d.cx, d.cy, r, 0, Math.PI * 2)
    ctx.fillStyle = '#0D0D0F'
    ctx.fill()
    if (d.selected) {
      ctx.lineWidth = 2
      ctx.strokeStyle = '#FFF'
      ctx.stroke()
    }
  }

}

function scheduleDraw() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    draw()
  })
}

function pointOf(e: MouseEvent) {
  const cv = canvasEl.value
  if (!cv) return null
  const rect = cv.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function hit(x: number, y: number): Dot | null {
  let best: Dot | null = null
  let bd = Infinity
  for (const d of dots) {
    const dist = (d.cx - x) ** 2 + (d.cy - y) ** 2
    if (dist < bd) {
      bd = dist
      best = d
    }
  }
  return bd <= 144 ? best : null // 12px 命中半径
}

function onMove(e: MouseEvent) {
  const p = pointOf(e)
  if (!p) return
  const d = hit(p.x, p.y)
  const key = d ? d.key : null
  if (key === hoverKey.value) return
  hoverKey.value = key
  if (canvasEl.value) canvasEl.value.style.cursor = key ? 'pointer' : 'default'
  emit('hover', key, d ? d.author : null)
  scheduleDraw()
}

function onLeave() {
  if (hoverKey.value === null) return
  hoverKey.value = null
  if (canvasEl.value) canvasEl.value.style.cursor = 'default'
  emit('hover', null, null)
  scheduleDraw()
}

function onClick(e: MouseEvent) {
  const p = pointOf(e)
  if (!p) return
  const d = hit(p.x, p.y)
  if (d) emit('select', d.key, d.author, d.slot)
}

onMounted(() => {
  draw()
  const cv = canvasEl.value
  if (cv && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(scheduleDraw)
    ro.observe(cv)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
})

watch(() => props.judgment, scheduleDraw)
watch(() => props.selectedKey, scheduleDraw)
// 落点集合变化时上报，父级据此取默认选中与「权威前 N 位」文案
watch(picked, (list) => emit('picked', list), { immediate: true })

// 计数口径 dev 断言（后端文档 §5.2 第 9 条）
if (import.meta.env.DEV) {
  watch(
    () => props.judgment,
    (j) => {
      const total = j.distribution.reduce((s, b) => s + b.authors.length, 0)
      if (total !== j.participantCount) {
        console.warn(
          `[MiniSpectrum] 计数口径漂移：Σ authors=${total} ≠ participantCount=${j.participantCount}（${j.id}）`,
        )
      }
    },
    { immediate: true },
  )
}
</script>

<template>
  <div class="spectrum">
    <canvas
      ref="canvasEl"
      class="spectrum__canvas"
      :style="{ height: `${CANVAS_H}px` }"
      role="img"
      :aria-label="ariaLabel"
      @mousemove="onMove"
      @mouseleave="onLeave"
      @click="onClick"
    />
    <div class="spectrum__ends">
      <span class="spectrum__end spectrum__end--l">{{ judgment.semanticAxis.left }}</span>
      <span class="spectrum__end spectrum__end--r">{{ judgment.semanticAxis.right }}</span>
    </div>
  </div>
</template>

<style scoped>
.spectrum {
  width: 100%;
}

.spectrum__canvas {
  display: block;
  width: 100%;
}

.spectrum__ends {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 12px;
  line-height: 18px;
}

.spectrum__end--l {
  color: var(--end-l);
}

.spectrum__end--r {
  color: var(--end-r);
}
</style>
