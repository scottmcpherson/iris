import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const coreDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(coreDir);
const binDir = process.platform === "win32" ? "Scripts" : "bin";
const python = join(coreDir, ".venv", binDir, process.platform === "win32" ? "python.exe" : "python");
const output = join(coreDir, "dist", process.platform === "win32" ? "iris-core.exe" : "iris-core");

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? coreDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

if (!existsSync(python)) {
  run("node", [join(root, "scripts", "setup-iris-core.mjs")], { cwd: root });
}

if (!existsSync(python)) {
  console.error("Missing iris-core/.venv. Run `npm run core:setup` first.");
  process.exit(1);
}

if (commandExists("uv")) {
  run("uv", ["pip", "install", "--python", python, "pyinstaller>=6.11"]);
} else {
  run(python, ["-m", "ensurepip", "--upgrade"]);
  run(python, ["-m", "pip", "install", "pyinstaller>=6.11"]);
}
rmSync(join(coreDir, "build"), { recursive: true, force: true });
run(python, ["-m", "PyInstaller", "--clean", "--noconfirm", "iris-core.spec"]);

if (!existsSync(output)) {
  console.error(`PyInstaller did not produce ${output}`);
  process.exit(1);
}

console.log(`Iris Core binary ready at ${output}`);
