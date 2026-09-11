import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

// tokens.css / global.css 由 ui agent 产出，可能晚于本文件出现
import '@/styles/tokens.css'
import '@/styles/global.css'

createApp(App).use(createPinia()).use(router).mount('#app')
