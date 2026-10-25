import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'web',
  plugins: [svelte({ configFile: resolve('svelte.config.js') })],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } }
});
