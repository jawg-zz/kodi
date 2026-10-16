import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative base: works on any host or subpath (kodi.spidmax.win/console, previews).
  base: './',
  server: { host: true, port: 5174, allowedHosts: ['.trycloudflare.com'] },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/victory') || id.includes('node_modules/d3-')) {
            return 'charts'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react'
          }
        },
      },
    },
  },
})
