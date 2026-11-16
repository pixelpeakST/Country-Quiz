// Build used for the claude.ai preview page: no service worker, everything inlined afterwards.
import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { outDir: 'dist-preview', assetsInlineLimit: 100000000, cssCodeSplit: false } });
