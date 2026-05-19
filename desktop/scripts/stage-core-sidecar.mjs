import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(desktopDir);
const source = join(root, "iris-core", "dist", process.platform === "win32" ? "iris-core.exe" : "iris-core");
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || defaultTargetTriple();

if (!targetTriple) {
  console.error("Could not infer a Tauri target triple for the Iris Core sidecar.");
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`Missing built Iris Core binary at ${source}. Run \`npm run core:build:binary\` first.`);
  process.exit(1);
}

const destinationDir = join(desktopDir, "src-tauri", "binaries");
const destination = join(destinationDir, `iris-core-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`);
mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);

console.log(`Staged Iris Core sidecar at ${destination}`);

function defaultTargetTriple() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  return "";
}
