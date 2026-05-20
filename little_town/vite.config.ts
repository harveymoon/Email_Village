import { defineConfig } from 'vite';

// Town Inbox renderer build config.
//
// `base: './'` makes the generated index.html reference its bundle via
// relative paths (./assets/index-xxx.js instead of /assets/...). That's
// what lets Electron load the built renderer via file:// — absolute
// paths would resolve against the filesystem root and 404.
//
// Vite's default port (5173) is what electron/main.cjs's RENDERER_DEV_URL
// expects, so no override needed there.

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
