import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreDir = join(root, "iris-core");
const venvDir = join(coreDir, ".venv");
const binDir = process.platform === "win32" ? "Scripts" : "bin";
const python = join(venvDir, binDir, process.platform === "win32" ? "python.exe" : "python");

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function pythonWorks() {
  if (!existsSync(python)) {
    return false;
  }
  const result = spawnSync(python, ["-c", "import encodings, sys; print(sys.version)"], { stdio: "ignore" });
  return result.status === 0;
}

await mkdir(coreDir, { recursive: true });

if (!pythonWorks()) {
  if (commandExists("uv")) {
    run("uv", ["venv", "--clear", "--python", "3.11", ".venv"], { cwd: coreDir });
  }

  const candidates = process.platform === "win32" ? ["py", "python"] : ["python3.11", "python3"];
  let created = false;

  if (!pythonWorks()) {
    for (const candidate of candidates) {
      const result = spawnSync(candidate, ["-m", "venv", ".venv"], {
        cwd: coreDir,
        env: process.env,
        stdio: "inherit",
      });

      if (result.status === 0) {
        created = true;
        break;
      }
    }
  }

  if (!created && !pythonWorks()) {
    console.error("Unable to create iris-core/.venv. Install Python 3.11+ and try again.");
    process.exit(1);
  }
}

if (commandExists("uv")) {
  run("uv", ["pip", "install", "--python", python, "-e", ".[dev]"], { cwd: coreDir });
} else {
  run(python, ["-m", "ensurepip", "--upgrade"]);
  run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(python, ["-m", "pip", "install", "-e", ".[dev]"], { cwd: coreDir });
}

console.log("\nIris Core virtualenv is ready at iris-core/.venv.");
