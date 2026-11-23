/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENAI_API_KEY?: string
  readonly VITE_TTS_PROVIDER?: string
  readonly VITE_STT_PROVIDER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
