import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'
import { vadAssets } from './vite/vadAssets.ts'

/** apps/client, wherever Vite is started from. */
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  // Empty prefix: read server-only variables too. Only VITE_* reach the browser.
  const env = loadEnv(mode, root, '')
  const serverUrl = env.JARVIS_SERVER_URL || 'http://127.0.0.1:5180'

  return {
    root,
    plugins: [vue(), vadAssets(root)],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // The API lives in apps/server. Forwarding keeps the browser on one origin.
      proxy: { '/api': { target: serverUrl, ws: true } },
    },
  }
})
