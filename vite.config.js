import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@canvas': fileURLToPath(new URL('./src/canvas', import.meta.url)),
    },
  },
  optimizeDeps: {
    // Scan active pages, not archived HTML or prebuilt public/canvas-app assets.
    entries: ['index.html', 'canvas.html'],
  },
  build: {
    outDir: 'web-dist',
  },
})
