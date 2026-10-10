import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// 开发期要点：
//  1) basicSsl 让开发服务器走 HTTPS —— getUserMedia/getDisplayMedia 在非 localhost 下必须 HTTPS，
//     否则手机通过局域网 IP 访问时无法开摄像头。
//  2) proxy 把 /ws、/token、/graphql、/healthz 代理到 Go 服务：前端只有一个源，既没有 CORS 问题，
//     也不会有 https 页面连 ws:// 的混合内容问题。
//     注意 /token 必须代理：忘了它的话前端会拿到 Vite 的 404、进而以"无令牌"入会，
//     在 AUTH_MODE=required 下表现为"缺少访问令牌"——排查起来很容易绕远路。
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    host: true, // 监听 0.0.0.0，手机可访问 https://<你的局域网IP>:5173
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/token': { target: 'http://localhost:8080', changeOrigin: true },
      '/graphql': { target: 'http://localhost:8080', changeOrigin: true },
      '/healthz': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
