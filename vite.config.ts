import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {isPrivateAssetPath} from './shared/static-assets.ts';

const rootDir = import.meta.dirname;

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'copy-public-assets',
        apply: 'build',
        writeBundle({dir}): void {
          const publicDir = path.resolve(rootDir, 'public');
          if (!dir || !fs.existsSync(publicDir)) return;
          fs.cpSync(publicDir, dir, {
            recursive: true,
            force: false,
            filter: (file) =>
              !isPrivateAssetPath(path.relative(publicDir, file)) && !fs.lstatSync(file).isSymbolicLink(),
          });
        },
      },
    ],
    build: {
      copyPublicDir: false,
      sourcemap: false,
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
      fs: {
        deny: [
          '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
          '**/.aistudio/**', '**/aistudio/**', '**/*.db*', '**/*.sqlite*', '**/server/**', '**/server.ts',
        ],
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
