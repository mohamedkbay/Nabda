import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("desktop/renderer");
const target = resolve("desktop-dist/renderer");
const fontTarget = resolve(target, "fonts/cairo-arabic-wght-normal.woff2");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (path) => !path.endsWith(".ts") && !path.endsWith(".d.ts"),
});
await mkdir(resolve(target, "fonts"), { recursive: true });
await cp(resolve("public/fonts/cairo-arabic-wght-normal.woff2"), fontTarget);
await cp(resolve("desktop/preload.cjs"), resolve("desktop-dist/preload.cjs"));
