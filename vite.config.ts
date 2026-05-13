import { defineConfig, type Plugin, type Connect } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createCaptureMiddleware } from './src/server/middleware'

function captureRoutes(): Plugin {
  return {
    name: 'claude-proxy-capture',
    configureServer(server) {
      const handler = createCaptureMiddleware()
      server.middlewares.use(handler as unknown as Connect.NextHandleFunction)
    },
    configurePreviewServer(server) {
      const handler = createCaptureMiddleware()
      server.middlewares.use(handler as unknown as Connect.NextHandleFunction)
    },
  }
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [captureRoutes(), tailwindcss(), tanstackStart(), viteReact()],
})
