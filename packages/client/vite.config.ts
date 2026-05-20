import { defineConfig } from 'vite'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    // More-specific paths must come first: `@mars/shared` → types.ts breaks subpath imports.
    alias: [
      {
        find: '@mars/shared/terrain',
        replacement: resolve(__dirname, '../shared/src/terrain.ts'),
      },
      {
        find: '@mars/shared',
        replacement: resolve(__dirname, '../shared/src/types.ts'),
      },
    ],
  },
})
