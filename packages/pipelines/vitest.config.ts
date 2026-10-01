import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@teleoffice/pptx-engine/table-grid': resolve(here, '../pptx-engine/src/table-grid.ts'),
      '@teleoffice/pptx-engine/identity': resolve(here, '../pptx-engine/src/identity.ts'),
      '@teleoffice/pptx-engine/background-promote': resolve(
        here,
        '../pptx-engine/src/background-promote.ts',
      ),
      '@teleoffice/pptx-engine/custgeom': resolve(here, '../pptx-engine/src/custgeom.ts'),
      '@teleoffice/pptx-engine': resolve(here, '../pptx-engine/src/index.ts'),
      '@teleoffice/pptx-render/preset-geometry': resolve(
        here,
        '../pptx-render/src/preset-geometry.ts',
      ),
      '@teleoffice/pptx-render': resolve(here, '../pptx-render/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
