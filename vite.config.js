// vite.config.js
import { defineConfig } from 'vite';
import { Buffer } from 'buffer';

export default defineConfig({
  define: {
    'global': 'globalThis',
    'process.env': process.env,
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      stream: 'stream-browserify',
      util: 'util',
      crypto: 'crypto-browserify'
    }
  },
  optimizeDeps: {
    include: ['buffer', '@solana/web3.js', '@solana/spl-token'],
    esbuildOptions: {
      target: 'esnext'
    }
  },
  server: {
    // use a different dev port to avoid colliding with the backend (which listens on 3000)
    port: 5173,
    open: true,
    proxy: {
      // forward /rpc and /prompt requests to the backend running on port 3100
      '/rpc': {
        target: 'http://localhost:3100',
        changeOrigin: true,
        secure: false
      },
      '/prompt': {
        target: 'http://localhost:3100',
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    sourcemap: false
  }
});