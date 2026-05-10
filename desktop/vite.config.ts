import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);

function packageFile(packageName: string, relativePath: string) {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath);
}

const previewRuntimes: Record<string, string> = {
  "virtual:preview-runtime/mermaid": packageFile("mermaid", "dist/mermaid.min.js"),
  "virtual:preview-runtime/react": packageFile("react", "umd/react.development.js"),
  "virtual:preview-runtime/react-dom": packageFile("react-dom", "umd/react-dom.development.js"),
};

function previewRuntimePlugin() {
  return {
    name: "preview-runtime",
    resolveId(id: string) {
      if (id in previewRuntimes) {
        return `\0${id}`;
      }
    },
    load(id: string) {
      if (!id.startsWith("\0")) {
        return;
      }

      const runtimePath = previewRuntimes[id.slice(1)];
      if (!runtimePath) {
        return;
      }

      return `export default ${JSON.stringify(readFileSync(runtimePath, "utf8"))};`;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [previewRuntimePlugin(), react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
