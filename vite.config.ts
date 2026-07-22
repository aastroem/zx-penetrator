import { defineConfig } from 'vite';
export default defineConfig({
  base: '/zx-penetrator/',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
