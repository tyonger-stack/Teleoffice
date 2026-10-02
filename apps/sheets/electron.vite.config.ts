import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // @teleoffice/* workspace packages ship TS source (no build step, no
    // compiled entry point) — externalizing them makes Node's ESM loader try
    // to resolve their relative imports at runtime and fail. Bundle those;
    // externalize everything else (Electron, zod, node builtins).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@teleoffice/ai-provider',
          '@teleoffice/agent-core',
          '@teleoffice/ai-search',
          '@teleoffice/docx-engine',
          '@teleoffice/file-parse',
          '@teleoffice/electron-utils',
          '@teleoffice/i18n',
          '@teleoffice/pptx-render',
          '@teleoffice/xlsx-gateway',
        ],
      }),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@teleoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
  },
})
