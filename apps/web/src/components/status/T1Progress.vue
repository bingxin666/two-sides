<script setup lang="ts">
/**
 * T1 生成中（docs/02 §6.2）：四阶段进度；RevealMask 由 QuestionPage 盖在光幕上
 * （设计稿 T1：光谱生成中 = 光幕从左向右被揭示），本组件只留文案 / 阶段 / 取消 / 看山。
 * 进度只读 GET /analysis 的 202 响应（stage + stageRatio），没有独立 progress 端点。
 * 看山动图（fox-t1，看山操作电脑 = 正在分析）：仅本组件挂载时加载/播放，
 * 进 N2 / 失败态即随组件卸载释放；180px 源展示 140px，禁进首屏（T1 是生成态非首屏）
 */
import { computed } from 'vue'
import type { ProgressResp, Stage } from '@two-sides/contract'

import foxT1 from '@/assets/liukanshan/fox-t1.webp'

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

const sampleCount = computed(() => props.progress?.sampleCount ?? 0)
</script>

<template>
  <section class="t1">
    <div class="t1__inner">
      <div class="t1__main">
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

      <img
        class="t1__fox"
        :src="foxT1"
        width="140"
        height="140"
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
      />
    </div>
  </section>
</template>

<style scoped>
.t1 {
  padding: 4px 0 8px;
}

.t1__inner {
  display: flex;
  align-items: center;
  gap: 24px;
}

.t1__main {
  flex: 1 1 auto;
  min-width: 0;
}

/* 看山操作电脑：陪跑生成过程，进 N2 / 失败态即随组件卸载释放 */
.t1__fox {
  flex: 0 0 auto;
  width: 140px;
  height: 140px;
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

@media (max-width: 1024px) {
  .t1__stages {
    flex-wrap: wrap;
    gap: 12px 24px;
  }

  .t1__fox {
    width: 96px;
    height: 96px;
  }
}
</style>
