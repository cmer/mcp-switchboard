import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import pkg from "./package.json";

const API_TARGET = `http://localhost:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": API_TARGET,
      "/oauth": API_TARGET,
      "/mcp": API_TARGET,
    },
  },
});
