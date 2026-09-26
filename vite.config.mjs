import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "renderer",
  plugins: [react()],
  build: {
    outDir: resolve("app/dist"),
    emptyOutDir: true,
  },
  base: "./",
});
