import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // The Android wrapper serves the bundle from https://appassets.androidplatform.net/,
  // so relative asset URLs are required (absolute "/assets/..." would resolve fine there,
  // but keeping them relative also lets the same build be opened straight from disk).
  base: './',
  build: {
    // One JS + one CSS file keeps the bundled WebView payload small and cache-friendly.
    assetsInlineLimit: 0,
  },
})
