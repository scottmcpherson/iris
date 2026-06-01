import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(desktopDir));
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

assertSidecarSupportsTarget(source, targetTriple);

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

function assertSidecarSupportsTarget(path, triple) {
  if (process.platform !== "darwin" || !triple.endsWith("-apple-darwin")) {
    return;
  }
  const required = triple === "universal-apple-darwin" ? ["x86_64", "arm64"] : [machArchForTargetTriple(triple)];
  const actual = macBinaryArchs(path);
  const missing = required.filter((arch) => !actual.includes(arch));
  if (missing.length > 0) {
    console.error(
      `Iris Core sidecar at ${path} does not support ${triple}. ` +
        `Missing ${missing.join(", ")} slice(s); found ${actual.join(", ") || "unknown"}.`,
    );
    if (triple === "universal-apple-darwin") {
      console.error("Build it first with `npm run core:build:binary:universal`.");
    }
    process.exit(1);
  }
}

function machArchForTargetTriple(triple) {
  const arch = triple.split("-")[0];
  if (arch === "aarch64") return "arm64";
  return arch;
}

function macBinaryArchs(path) {
  const result = spawnSync("lipo", ["-archs", path], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`Unable to inspect architectures for ${path}.`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}
