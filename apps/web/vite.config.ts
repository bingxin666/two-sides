import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 注意：这里只做构建配置，不含任何密钥。
 * 前端仅认识两个环境变量：VITE_API_MODE / VITE_API_BASE（见 .env.development）。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@two-sides/contract': fileURLToPath(
        new URL('../../packages/contract/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    // API 与公开 OAuth 回调都由 Bun 服务处理，与生产代理保持一致。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/callback': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
