import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// `npm run dev:host -- --https` serves over TLS so that getUserMedia works on a
// phone reaching this machine by LAN IP (secure-context requirement).
const wantsHttps = process.argv.includes('--https');

export default defineConfig(async () => ({
  plugins: [
    preact(),
    ...(wantsHttps ? [(await import('@vitejs/plugin-basic-ssl')).default()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Light Spark',
        short_name: 'Light Spark',
        description: 'Dateien übertragen nur mit Licht — Bildschirm sendet, Kamera empfängt.',
        lang: 'de',
        theme_color: '#0b0e14',
        background_color: '#0b0e14',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
}));
