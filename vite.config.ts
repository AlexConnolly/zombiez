import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 800, rollupOptions: { input: { main: 'index.html', p2p: 'p2p.html' } } },
  // Listen on every interface so friends on the network (or through port forwarding) can load the game.
  server: { host: true, port: 5317, strictPort: true },
  test: { environment: 'node' },
});
