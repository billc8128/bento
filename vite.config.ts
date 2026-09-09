/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

// BENTO_WEB=1 时跳过 Electron,纯浏览器跑 UI(主题/布局调试用)
const webOnly = process.env.BENTO_WEB === '1'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    !webOnly &&
      electron({
        main: {
          entry: 'electron/main.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rolldownOptions: {
                // 协议/Agent SDK 留在 node_modules:Agent SDK 需按包目录定位内置 cli.js。
                external: ['electron-updater', '@agentclientprotocol/sdk', '@anthropic-ai/claude-agent-sdk', /^@modelcontextprotocol\/sdk/, 'node-pty'],
              },
            },
          },
        },
        preload: {
          input: 'electron/preload.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: {
                // preload 必须是 CJS(沙箱内只有受限 require),显式 .cjs 防止 ESM 误判
                output: { format: 'cjs', entryFileNames: '[name].cjs' },
              },
            },
          },
        },
      }),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    // prototypes/ 是独立 Vite 原型项目(node:test 断言风格),不归主项目 vitest 跑
    exclude: ['**/node_modules/**', 'prototypes/**'],
  },
})
