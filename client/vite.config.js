import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the API runs on :3000 and Vite proxies to it.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000', '/webhook': 'http://localhost:3000' } },
});
