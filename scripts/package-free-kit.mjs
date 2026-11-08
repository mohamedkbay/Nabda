import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Explicit, non-recursive allowlist. Never package workspace/private server data.
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--public-dir")) {
  throw new Error("Usage: node scripts/package-free-kit.mjs [--public-dir DIRECTORY]");
}
const publicDir = args.length ? path.resolve(args[1]) : path.join(root, "public");
const files = [
  ["public/api-kit/README.md", "README.md"],
  ["public/api-kit/nabda.mjs", "api-kit/nabda.mjs"],
  ["public/api-kit/nabda.py", "api-kit/nabda.py"],
  ["public/api-kit/Nabda.postman_collection.json", "api-kit/Nabda.postman_collection.json"],
  ["public/api-kit/Nabda.postman_environment.json", "api-kit/Nabda.postman_environment.json"],
  ["public/downloads/Nabda-Android-0.2.0.apk", "downloads/Nabda-Android-0.2.0.apk"],
  ["public/downloads/THIRD-PARTY-NOTICES.txt", "downloads/THIRD-PARTY-NOTICES.txt"],
  ["public/openapi.json", "openapi.json"],
];
for (const [source] of files) {
  const resolved = await fs.realpath(path.join(publicDir, source.slice("public/".length)));
  if (!resolved.startsWith(publicDir + path.sep)) throw new Error(`Refusing source outside public directory: ${source}`);
  if (!(await fs.stat(resolved)).isFile()) throw new Error(`Not a regular release file: ${source}`);
}
const output = path.join(publicDir, "downloads/Nabda-Free-Starter-0.2.0.zip");
const python = String.raw`
import hashlib, json, os, pathlib, sys, zipfile
root, output, files = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), json.loads(sys.argv[3])
entries = {name: (root / source[len('public/'):]).read_bytes() for source, name in files}
with zipfile.ZipFile(root / 'downloads/Nabda-Android-0.2.0.apk') as apk:
    if 'AndroidManifest.xml' not in apk.namelist() or apk.testzip() is not None:
        raise ValueError('The Android APK is not a complete valid archive')
manifest = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n' for name, data in sorted(entries.items()))
entries['SHA256SUMS.txt'] = manifest.encode('utf-8')
temporary = output.with_suffix('.zip.tmp')
try:
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            item = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            item.create_system = 3
            item.external_attr = (0o100644 << 16)
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None or sorted(archive.namelist()) != sorted(entries):
            raise ValueError('Release archive verification failed')
    os.replace(temporary, output)
except BaseException:
    temporary.unlink(missing_ok=True)
    raise
digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(digest + '  ' + output.name + '\n', encoding='utf-8')
print(json.dumps({'archive': str(output), 'files': len(entries), 'bytes': output.stat().st_size, 'sha256': digest}))
`;
const result = spawnSync("python3", ["-c", python, publicDir, output, JSON.stringify(files)], { encoding: "utf8", maxBuffer: 1024 * 1024 });
if (result.error) throw new Error("Python 3 is required to build the reproducible starter ZIP.");
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
process.stdout.write(result.stdout);
