import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const webOnly = args.has("--web");
const withCore = !args.has("--no-core");
const children = [];

const binDir = process.platform === "win32" ? "Scripts" : "bin";
const exe = process.platform === "win32" ? ".exe" : "";
const coreBin = join(root, "iris-core", ".venv", binDir, `iris-core${exe}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const hermesHome = expandHome(process.env.HERMES_HOME ?? join(homedir(), ".hermes"));
const coreHost = process.env.IRIS_CORE_HOST ?? "127.0.0.1";
const corePort = process.env.IRIS_CORE_PORT ?? "8765";
const hermesEnvPath = join(hermesHome, ".env");
const discoveredHermesApiToken = readEnvFileValue(hermesEnvPath, "API_SERVER_KEY");
const hermesApiToken = process.env.HERMES_API_TOKEN || discoveredHermesApiToken;
const hermesApiTokenSource = process.env.HERMES_API_TOKEN
  ? "environment"
  : discoveredHermesApiToken
    ? hermesEnvPath
    : "";
const irisToken = process.env.IRIS_TOKEN || "";
const devEnv = {
  IRIS_CORE_HOST: coreHost,
  IRIS_CORE_PORT: corePort,
  IRIS_CORE_API_URL: `http://${coreHost}:${corePort}`,
  ...(process.env.IRIS_CORE_STORE ? { IRIS_CORE_STORE: process.env.IRIS_CORE_STORE } : {}),
  HERMES_HOME: hermesHome,
  ...(hermesApiToken ? { HERMES_API_TOKEN: hermesApiToken } : {}),
  ...(irisToken ? { IRIS_TOKEN: irisToken } : {}),
};

function prefix(label, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length) {
      console.log(`[${label}] ${line}`);
    }
  }
}

function run(label, command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => prefix(label, chunk));
  child.stderr.on("data", (chunk) => prefix(label, chunk));
  child.on("exit", (code, signal) => {
    if (signal) {
      return;
    }

    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 250);
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function readEnvFileValue(path, key) {
  if (!existsSync(path)) return "";
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(`${key}=`)) continue;
      return unquoteEnvValue(trimmed.slice(key.length + 1).trim());
    }
  } catch {
    return "";
  }
  return "";
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (hermesApiTokenSource) {
  console.log(`[dev] using Hermes Jobs API token as an Iris Core runtime default from ${hermesApiTokenSource}`);
} else {
  console.log("[dev] no Hermes Jobs API token found; Iris Core runtime automation calls may require HERMES_API_TOKEN");
}
if (irisToken) {
  console.log("[dev] using Iris token from environment");
}

async function coreIsAlreadyRunning() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://${coreHost}:${corePort}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

if (withCore) {
  if (!existsSync(coreBin)) {
    console.error("Missing iris-core/.venv. Run `npm run core:setup` first.");
    process.exit(1);
  }

  if (await coreIsAlreadyRunning()) {
    console.log(`[iris-core] using existing server at http://${coreHost}:${corePort}`);
  } else {
    run("iris-core", coreBin, ["--hermes-home", hermesHome, "--host", coreHost, "--port", corePort], {
      env: devEnv,
    });
  }
}

if (webOnly) {
  run("desktop", npm, ["--workspace", "desktop", "run", "dev"], { env: devEnv });
} else {
  run("desktop", npm, [
    "--workspace",
    "desktop",
    "run",
    "tauri",
    "dev",
    "--",
    "--config",
    "src-tauri/tauri.dev.conf.json",
  ], { env: devEnv });
}
