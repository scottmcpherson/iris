import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = process.platform === "win32" ? "Scripts" : "bin";
const python = join(
  root,
  "iris-core",
  ".venv",
  binDir,
  process.platform === "win32" ? "python.exe" : "python",
);

if (!existsSync(python)) {
  console.error("Missing iris-core/.venv. Run `npm run core:setup` first.");
  process.exit(1);
}

const args = ["-m", "pytest", "iris-core", ...process.argv.slice(2)];
console.log(`> ${python} ${args.join(" ")}`);

const result = spawnSync(python, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
