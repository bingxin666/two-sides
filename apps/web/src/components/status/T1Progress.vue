<script setup lang="ts">
/**
 * T1 生成中（docs/02 §6.2）：四阶段进度 + RevealMask
 * 进度只读 GET /analysis 的 202 响应（stage + stageRatio），没有独立 progress 端点
 */
import { computed } from 'vue'
import type { ProgressResp, Stage } from '@two-sides/contract'

const props = withDefaults(defineProps<{ progress?: ProgressResp | null }>(), { progress: null })
const emit = defineEmits<{ (e: 'cancel'): void }>()

const STAGES: { key: Stage; no: string; label: string }[] = [
  { key: 'extract', no: '01', label: '提取判断' },
  { key: 'merge', no: '02', label: '归并去重' },
  { key: 'orient', no: '03', label: '取向归位' },
  { key: 'render', no: '04', label: '生成光谱' },
]

const stageIndex = computed(() => {
  const idx = STAGES.findIndex((s) => s.key === props.progress?.stage)
  return idx < 0 ? 0 : idx
})

const stageRatio = computed(() => Math.min(1, Math.max(0, props.progress?.stageRatio ?? 0)))

/** 总进度 0..1：四阶段均分 + 当前阶段内部推进比 */
const total = computed(() => Math.min(1, (stageIndex.value + stageRatio.value) / STAGES.length))

const sampleCount = computed(() => props.progress?.sampleCount ?? 0)
</script>

<template>
  <section class="t1">
    <div class="t1__inner">
      <!-- sampleCount 未就绪时诚实降级，不显示「从 0 条回答」 -->
      <p v-if="sampleCount > 0" class="t1__lead">正在从 {{ sampleCount }} 条回答中提炼判断</p>
      <p v-else class="t1__lead">正在检索相关回答</p>

      <ol class="t1__stages">
        <li
          v-for="(s, i) in STAGES"
          :key="s.key"
          class="stage"
          :class="{
            'stage--done': i < stageIndex,
            'stage--current': i === stageIndex,
            'stage--wait': i > stageIndex,
          }"
        >
          <span class="stage__no">{{ s.no }}</span>
          <span class="stage__label">{{ s.label }}</span>
        </li>
      </ol>

      <button type="button" class="t1__cancel" @click="emit('cancel')">取消</button>
    </div>

    <div class="t1__mask" :style="{ width: `${(1 - total) * 100}%` }" aria-hidden="true" />
  </section>
</template>

<style scoped>
.t1 {
  position: relative;
  overflow: hidden;
  padding: 4px 0 8px;
}

.t1__lead {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 14px;
  line-height: 22px;
  color: var(--ink-soft);
}

.t1__stages {
  display: flex;
  gap: 28px;
  margin-top: 18px;
}

.stage {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 14px;
  line-height: 22px;
}

.stage__no {
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 11px;
}

.stage--done {
  color: var(--muted);
}

.stage--current {
  color: var(--ink);
}

.stage--wait {
  color: var(--faint);
}

.t1__cancel {
  margin-top: 20px;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}

.t1__cancel:hover {
  color: var(--ink);
}

/* 右侧白 → 左侧透明，宽度随总进度收窄 */
.t1__mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(270deg, #FFF 0%, #FFF 55%, rgba(255, 255, 255, 0) 100%);
  pointer-events: none;
  transition: width .4s linear;
}

@media (max-width: 1024px) {
  .t1__stages {
    flex-wrap: wrap;
    gap: 12px 24px;
  }
}
</style>
