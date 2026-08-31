import { rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const outputDirectory = resolve(process.cwd(), "desktop-dist");

if (basename(outputDirectory) !== "desktop-dist") {
  throw new Error("Refusing to clean an unexpected desktop output directory");
}

rmSync(outputDirectory, { recursive: true, force: true });
