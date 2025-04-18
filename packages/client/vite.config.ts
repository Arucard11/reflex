import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths'; // Import the plugin
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths() // Add the tsconfigPaths plugin
  ],
  resolve: {
    alias: {
      // Ensure aliases match your tsconfig paths if needed
      // Example: '@shared': path.resolve(__dirname, '../shared/src'),
    },
    dedupe: ['react', 'react-dom'], // Explicitly deduplicate React and React DOM
  },
  server: {
    port: 3000, // Run dev server on port 3000
    strictPort: true, // Fail if port 3000 is already in use
    hmr: {
      protocol: 'ws', // Use websocket for HMR
      host: 'localhost',
    },
    // Optional: Proxy API requests to the server
    // proxy: {
    //   '/api': 'http://localhost:3001',
    // },
  },
  // Ensure shared package is processed correctly
  optimizeDeps: {
    include: ['@shared/*']
  },
  build: {
    commonjsOptions: {
      include: [/shared/, /node_modules/]
    }
  }
}); 