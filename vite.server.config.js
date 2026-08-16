import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'server/index.js',
    outDir: 'server-dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js'
      }
    }
  },
  ssr: {
    noExternal: true
  }
})
