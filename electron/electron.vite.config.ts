import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Spec 1: 后端 URL 可由 VITE_LINGSHU_BACKEND_URL 覆盖,
// verify E2E 用此重定向到 3101,默认本地 dev 用 3000。
// 解析发生在 defineConfig 工厂里,确保 render 端编译时常量被正确替换。
const backendHttp = process.env.VITE_LINGSHU_BACKEND_URL ?? 'http://127.0.0.1:3000';
const backendWs = backendHttp.replace(/^http/, 'ws') + '/ws';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/main/main.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        external: ['electron'],
      },
      outExtension: { '.js': '.js' },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/main/preload.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        external: ['electron'],
      },
      outExtension: { '.js': '.js' },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    server: {
      // Vite dev server 代理 /api → 后端 (Electron 内通过 __BACKEND_HTTP_URL__ 也可直接访问,
      // 但浏览器调试/E2E 测试需要 proxy 否则 CORS)
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: backendHttp,
          changeOrigin: true,
        },
        '/chat': {
          target: backendHttp,
          changeOrigin: true,
        },
        '/ws': {
          target: backendWs,
          ws: true,
        },
      },
    },
    define: {
      __BACKEND_HTTP_URL__: JSON.stringify(backendHttp),
      __BACKEND_WS_URL__: JSON.stringify(backendWs),
    },
  },
});