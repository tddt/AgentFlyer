import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    process: JSON.stringify({ env: { NODE_ENV: 'production' } }),
  },
  build: {
    lib: {
      entry: 'src/main.tsx',
      formats: ['iife'],
      name: 'AgentFlyerConsole',
      fileName: () => 'index.js',
    },
    cssCodeSplit: false,
    outDir: 'dist',
    rollupOptions: {
      external: [],
      output: {
        assetFileNames: (asset) => {
          const name = Array.isArray(asset.names) ? asset.names[0] : asset.name
          return name?.endsWith('.css') ? 'index.css' : (name ?? 'asset')
        },
      },
    },
  },
})
