import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const project = fileURLToPath(new URL("../../", import.meta.url));

export function dashboardConfig(settings) {
  return defineConfig({
    configFile: false,
    root: fileURLToPath(new URL("./", import.meta.url)),
    base: "/",
    publicDir: false,
    plugins: [react()],
    define: { "import.meta.env.VITE_NABDA_WEBSITE_ORIGIN": JSON.stringify(settings.WEBSITE_ORIGIN) },
    build: { outDir: path.join(project, "deploy-build/cloudflare-assets"), emptyOutDir: true, sourcemap: false },
  });
}
