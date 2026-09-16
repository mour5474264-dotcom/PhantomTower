import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  plugins: [vue(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@canvas': fileURLToPath(new URL('./src/canvas', import.meta.url))
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
    __APP_RELEASES__: '[]'
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
      },
    },
  },
  // `public/canvas-app` contains a legacy prebuilt standalone canvas. It is a
  // static asset, not a Vite application entry; scanning its index.html makes
  // Vite chase its old dependency graph and repeatedly reload this app.
  optimizeDeps: {
    entries: ['index.html'],
  },
  base: './',
  build: {
    outDir: 'web-dist',
    rollupOptions: {
      // The canvas deliberately has its own document.  It prevents its React
      // router and global styles from remounting or restyling the Vue shell.
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        canvas: fileURLToPath(new URL('./canvas.html', import.meta.url)),
      },
    },
  },
})
