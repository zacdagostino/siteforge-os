import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['silver-fiesta-xg6xjqvw4pvhp477-5173.app.github.dev'],
  },
});
