import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binariesDir = join(desktopDir, "src-tauri", "binaries");
const entitlements = join(desktopDir, "src-tauri", "Entitlements.plist");
const identity = process.env.APPLE_SIGNING_IDENTITY;
const requestedSidecars = process.argv.slice(2);
const sidecars =
  requestedSidecars.length > 0
    ? requestedSidecars
    : ["iris-core-aarch64-apple-darwin", "iris-core-x86_64-apple-darwin"];

if (process.platform !== "darwin") {
  console.error("macOS sidecar signing must run on macOS.");
  process.exit(1);
}

if (!identity) {
  console.error("Missing APPLE_SIGNING_IDENTITY for macOS sidecar signing.");
  process.exit(1);
}

if (!existsSync(entitlements)) {
  console.error(`Missing entitlements file at ${entitlements}.`);
  process.exit(1);
}

for (const sidecar of sidecars) {
  const path = sidecar.includes("/") ? sidecar : join(binariesDir, sidecar);
  if (!existsSync(path)) {
    console.error(`Missing sidecar at ${path}.`);
    process.exit(1);
  }

  run("codesign", [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    "--sign",
    identity,
    path,
  ]);
  run("codesign", ["--verify", "--strict", "--verbose=2", path]);
}

console.log("macOS sidecars are signed.");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    console.error(`${command} ${redactedArgs(args).join(" ")} failed.`);
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }
}

function redactedArgs(args) {
  return args.map((arg, index) => (args[index - 1] === "--sign" ? "<identity>" : arg));
}
