import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binariesDir = join(desktopDir, "src-tauri", "binaries");
const required = [
  ["iris-core-aarch64-apple-darwin", "arm64"],
  ["iris-core-x86_64-apple-darwin", "x86_64"],
];

for (const [fileName, arch] of required) {
  const path = join(binariesDir, fileName);
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Stage both macOS Iris Core sidecars before building a universal app.`);
    process.exit(1);
  }
  const actual = macBinaryArchs(path);
  if (!actual.includes(arch)) {
    console.error(`${path} is missing ${arch}; found ${actual.join(", ") || "unknown"}.`);
    process.exit(1);
  }
}

console.log("Universal macOS sidecars are staged.");

function macBinaryArchs(path) {
  const result = spawnSync("lipo", ["-archs", path], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`Unable to inspect architectures for ${path}.`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}
