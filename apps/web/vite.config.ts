import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("apps/web"),
  plugins: [react()],
  build: { outDir: resolve("dist/web"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // 本地联调可指向另一个 API 实例，避免覆盖正在运行的部署。
    proxy: { "/api": process.env.TESSERA_API_TARGET || "http://127.0.0.1:8000" },
    // 编辑器原子写入会在同目录留下临时文件；监听到这些临时目录会让 watcher 崩溃。
    watch: { ignored: ["**/.*.tmpdir/**", "**/*.tmp"] },
  },
});
