import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 两个路由，页面一律懒加载。
 * N3（展开某条钉子）不是独立路由 —— 同路由内状态，靠 ?j=<judgmentId> 恢复。
 */
const routes: RouteRecordRaw[] = [
  {
    name: 'home',
    path: '/',
    component: () => import('@/pages/HomePage.vue'),
  },
  {
    name: 'question',
    path: '/q/:qid',
    component: () => import('@/pages/QuestionPage.vue'),
    props: true,
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 }
  },
})

export default router
