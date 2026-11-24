import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

const rootDir = import.meta.dirname;

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(rootDir, 'dist');
          const srcAssets = path.resolve(rootDir, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const p = id.replace(/\\/g, '/');
            if (!p.includes('/node_modules/')) return undefined;
            if (
              p.includes('/node_modules/react/') ||
              p.includes('/node_modules/react-dom/') ||
              p.includes('/node_modules/react-router-dom/') ||
              p.includes('/node_modules/react-router/') ||
              p.includes('/node_modules/scheduler/')
            ) {
              return 'react-vendor';
            }
            if (p.includes('/node_modules/@tanstack/') || p.includes('/node_modules/zustand/')) {
              return 'query-vendor';
            }
            if (
              p.includes('/node_modules/lucide-react/') ||
              p.includes('/node_modules/sonner/') ||
              p.includes('/node_modules/clsx/') ||
              p.includes('/node_modules/tailwind-merge/')
            ) {
              return 'ui-vendor';
            }
            if (p.includes('/node_modules/axios/')) {
              return 'http-vendor';
            }
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(rootDir, './src'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
