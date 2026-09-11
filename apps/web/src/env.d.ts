/// <reference types="vite/client" />

/** 本项目前端只认识这两个环境变量，均非密钥 */
interface ImportMetaEnv {
  readonly VITE_API_MODE?: 'mock' | 'live'
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
