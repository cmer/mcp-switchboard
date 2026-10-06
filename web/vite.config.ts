import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import pkg from "./package.json";

const API_TARGET = `http://localhost:${process.env.API_PORT ?? 8787}`;
// MCP_PORT gives the agent endpoint its own listener; follow it so dev mode keeps working.
const MCP_TARGET = process.env.MCP_PORT ? `http://localhost:${process.env.MCP_PORT}` : API_TARGET;

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
      // The upstream-OAuth callback belongs to the admin app; the rest of /oauth is the agent-facing
      // authorization server, which lives beside /mcp. First matching key wins.
      "/oauth/callback": API_TARGET,
      "/oauth": MCP_TARGET,
      "/.well-known": MCP_TARGET,
      "/mcp": MCP_TARGET,
    },
  },
});
