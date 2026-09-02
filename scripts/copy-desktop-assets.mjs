import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("desktop/controller/web");
const target = resolve("desktop-dist/controller/web");
const fontTarget = resolve(target, "cairo.woff2");
const vendorTarget = resolve(target, "vendor");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (path) => !path.endsWith(".ts") && !path.endsWith(".d.ts"),
});
await cp(resolve("public/fonts/cairo-arabic-wght-normal.woff2"), fontTarget);
await mkdir(vendorTarget, { recursive: true });
await cp(resolve("desktop/renderer/vendor/lucide.js"), resolve(vendorTarget, "lucide.js"));
await cp(resolve("node_modules/qrcode-generator/dist/qrcode.js"), resolve(vendorTarget, "qrcode.js"));
