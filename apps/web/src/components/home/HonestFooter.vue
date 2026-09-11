<script setup lang="ts">
/**
 * 诚实声明行：样本 / 偏差 / 立场 三段，常驻不隐藏（docs/02 §8 诚实设计）
 */
const items = [
  { label: '样本', text: '结论来自当日抓取的回答样本，不声称覆盖全部回答。' },
  { label: '偏差', text: '判断与归位由模型提炼，可能存在偏差；每条判断可回溯原话与归位理由。' },
  { label: '立场', text: '不评判对错，只呈现分布；光谱两端由该判断自身内容推导。' },
]
</script>

<template>
  <footer class="honest">
    <p v-for="it in items" :key="it.label" class="honest__item">
      <span class="honest__label">{{ it.label }}</span>
      <span class="honest__text">{{ it.text }}</span>
    </p>
  </footer>
</template>

<style scoped>
.honest {
  display: flex;
  align-items: flex-start;
  gap: 40px;
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}

.honest__item {
  display: flex;
  gap: 6px;
  max-width: 380px;
}

.honest__label {
  flex: 0 0 auto;
  font-weight: 500;
  color: var(--ink-soft);
}

@media (max-width: 1024px) {
  .honest {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
