import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Content-Security-Policy for the built app (the dev server needs inline scripts, so only at build time). It is a
// <meta> tag, so it holds however the page is served (nginx in Docker, the engine itself without Docker).
// - scripts only from the app itself; no plugins; forms and <base> only to the app
// - images and media only from the app, blob: and data: — an image from another server could carry data out
// - connect-src allows https: because the cloud model (the user's choice, any base URL) and live market prices
//   (opt-in) are called from the page; localhost for LM Studio or another local server
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const csp = {
  name: 'starkllm-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), csp],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
