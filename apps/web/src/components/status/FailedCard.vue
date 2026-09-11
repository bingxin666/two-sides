<script setup lang="ts">
/**
 * 失败卡片（docs/02 §6.3）
 *  - 文案按 error.code 取 ERROR_COPY；retryable 为 true 才渲染重试按钮
 *  - 点击后立即禁用 + 60s 冷却（与后端冷却一致），防止连点打穿额度
 *  - 保留返回入口，不让用户卡在死胡同
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { ERROR_COPY } from '@two-sides/contract'
import type { ProgressError } from '@two-sides/contract'

const props = withDefaults(defineProps<{ error?: ProgressError | null }>(), { error: null })
const emit = defineEmits<{ (e: 'retry'): void; (e: 'back'): void }>()

const COOLDOWN = 60

const message = computed(() => {
  const e = props.error
  if (!e) return '生成失败，请稍后再试'
  return ERROR_COPY[e.code]?.message ?? e.message
})

const retryable = computed(() => props.error?.retryable ?? false)

const cooldown = ref(0)
let timer: number | undefined

function onRetry() {
  if (!retryable.value || cooldown.value > 0) return
  cooldown.value = COOLDOWN
  emit('retry')
  timer = window.setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0 && timer) {
      window.clearInterval(timer)
      timer = undefined
    }
  }, 1000)
}

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  timer = undefined
})
</script>

<template>
  <section class="failed">
    <p class="failed__title">{{ message }}</p>
    <p class="failed__hint">快照为终态，不会自动重试；明天会用当日新数据重新生成。</p>

    <div class="failed__actions">
      <button
        v-if="retryable"
        type="button"
        class="failed__retry"
        :disabled="cooldown > 0"
        @click="onRetry"
      >
        {{ cooldown > 0 ? `重试（${cooldown}s）` : '重试' }}
      </button>
      <button type="button" class="failed__back" @click="emit('back')">返回首页</button>
    </div>
  </section>
</template>

<style scoped>
.failed__title {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 17px;
  line-height: 27px;
  color: var(--ink);
}

.failed__hint {
  margin-top: 6px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

.failed__actions {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 18px;
}

.failed__retry {
  height: 40px;
  padding: 0 24px;
  border-radius: 20px;
  background: var(--ink);
  color: #FFF;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 13px;
  transition: opacity .2s ease;
}

.failed__retry:disabled {
  background: var(--faint);
  cursor: not-allowed;
}

.failed__back {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}

.failed__back:hover {
  color: var(--ink);
}
</style>
