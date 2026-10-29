import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Code-block runtimes are module workers (src/code/runtime.ts; Pyodide refuses classic workers).
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
  },
});
