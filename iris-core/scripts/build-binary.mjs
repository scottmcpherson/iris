import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const coreDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(coreDir);
const binDir = process.platform === "win32" ? "Scripts" : "bin";
const python = join(coreDir, ".venv", binDir, process.platform === "win32" ? "python.exe" : "python");
const output = join(coreDir, "dist", process.platform === "win32" ? "iris-core.exe" : "iris-core");
const targetArch = parseTargetArch();

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? coreDir,
    env: options.env ?? process.env,
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

if (targetArch) {
  assertTargetArchSupport(python, targetArch, "Iris Core Python");
}

if (commandExists("uv")) {
  run("uv", ["pip", "install", "--python", python, "pyinstaller>=6.11"]);
} else {
  run(python, ["-m", "ensurepip", "--upgrade"]);
  run(python, ["-m", "pip", "install", "pyinstaller>=6.11"]);
}
rmSync(join(coreDir, "build"), { recursive: true, force: true });
run(python, ["-m", "PyInstaller", "--clean", "--noconfirm", "iris-core.spec"], {
  env: {
    ...process.env,
    ...(targetArch ? { PYINSTALLER_TARGET_ARCH: targetArch } : {}),
  },
});

if (!existsSync(output)) {
  console.error(`PyInstaller did not produce ${output}`);
  process.exit(1);
}

if (targetArch) {
  assertTargetArchSupport(output, targetArch, "Iris Core binary");
}

console.log(`Iris Core binary ready at ${output}`);

function parseTargetArch() {
  let value = process.env.IRIS_CORE_TARGET_ARCH || process.env.PYINSTALLER_TARGET_ARCH || "";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target-arch") {
      value = args[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--target-arch=")) {
      value = arg.slice("--target-arch=".length);
    }
  }
  value = value.trim();
  if (!value) return "";
  const allowed = new Set(["x86_64", "arm64", "universal2"]);
  if (!allowed.has(value)) {
    console.error(`Unsupported Iris Core target architecture "${value}". Expected x86_64, arm64, or universal2.`);
    process.exit(1);
  }
  if (process.platform !== "darwin") {
    console.error("--target-arch is only supported for macOS PyInstaller builds.");
    process.exit(1);
  }
  return value;
}

function assertTargetArchSupport(path, arch, label) {
  const required = arch === "universal2" ? ["x86_64", "arm64"] : [arch];
  const actual = macBinaryArchs(path);
  const missing = required.filter((item) => !actual.includes(item));
  if (missing.length > 0) {
    console.error(
      `${label} at ${path} is missing ${missing.join(", ")} architecture slice(s). ` +
        `Found: ${actual.join(", ") || "unknown"}.`,
    );
    if (arch === "universal2" && label.endsWith("Python")) {
      console.error("Install a python.org macOS universal2 Python and recreate iris-core/.venv before building universal.");
    }
    process.exit(1);
  }
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
