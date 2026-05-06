import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const webOnly = args.has("--web");
const withSidecar = !args.has("--no-sidecar");
const children = [];

const binDir = process.platform === "win32" ? "Scripts" : "bin";
const exe = process.platform === "win32" ? ".exe" : "";
const sidecarBin = join(root, "sidecar", ".venv", binDir, `hermes-sidecar${exe}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const hermesHome = expandHome(process.env.HERMES_HOME ?? join(homedir(), ".hermes"));
const sidecarHost = process.env.HERMES_MGMT_HOST ?? "127.0.0.1";
const sidecarPort = process.env.HERMES_MGMT_PORT ?? "8765";
const hermesEnvPath = join(hermesHome, ".env");
const discoveredHermesApiToken = readEnvFileValue(hermesEnvPath, "API_SERVER_KEY");
const hermesApiToken = process.env.HERMES_API_TOKEN || discoveredHermesApiToken;
const hermesApiTokenSource = process.env.HERMES_API_TOKEN
  ? "environment"
  : discoveredHermesApiToken
    ? hermesEnvPath
    : "";
const irisInboxToken = process.env.IRIS_INBOX_TOKEN || process.env.IRIS_TOKEN || "";
const irisToken = process.env.IRIS_TOKEN || irisInboxToken;
const agentuiInboxToken = process.env.AGENTUI_INBOX_TOKEN || process.env.AGENTUI_TOKEN || "";
const agentuiToken = process.env.AGENTUI_TOKEN || agentuiInboxToken;
const inboxToken = irisInboxToken || agentuiInboxToken;
const platformToken = irisToken || agentuiToken || inboxToken;
const sidecarToken =
  process.env.IRIS_CORE_TOKEN ||
  process.env.HERMES_SIDECAR_TOKEN ||
  process.env.HERMES_MGMT_TOKEN ||
  process.env.HERMES_REMOTE_TOKEN ||
  inboxToken;
const devEnv = {
  HERMES_HOME: hermesHome,
  HERMES_MGMT_HOST: sidecarHost,
  HERMES_MGMT_PORT: sidecarPort,
  ...(hermesApiToken ? { HERMES_API_TOKEN: hermesApiToken } : {}),
  ...(platformToken ? { IRIS_TOKEN: platformToken, AGENTUI_TOKEN: platformToken } : {}),
  ...(inboxToken ? { IRIS_INBOX_TOKEN: inboxToken, AGENTUI_INBOX_TOKEN: inboxToken } : {}),
  ...(sidecarToken ? { HERMES_SIDECAR_TOKEN: sidecarToken } : {}),
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
  console.log(`[dev] using Hermes API token from ${hermesApiTokenSource}`);
} else {
  console.log(`[dev] no Hermes API token found; Automations job management may require HERMES_API_TOKEN`);
}
if (inboxToken) {
  console.log("[dev] using Iris inbox token from environment");
}

async function sidecarIsAlreadyRunning() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://${sidecarHost}:${sidecarPort}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

if (withSidecar) {
  if (!existsSync(sidecarBin)) {
    console.error("Missing sidecar/.venv. Run `npm run sidecar:setup` first.");
    process.exit(1);
  }

  if (await sidecarIsAlreadyRunning()) {
    console.log(`[sidecar] using existing server at http://${sidecarHost}:${sidecarPort}`);
  } else {
    run("sidecar", sidecarBin, ["--hermes-home", hermesHome, "--host", sidecarHost, "--port", sidecarPort], {
      env: devEnv,
    });
  }
}

if (webOnly) {
  run("desktop", npm, ["--workspace", "desktop", "run", "dev"], { env: devEnv });
} else {
  run("desktop", npm, ["--workspace", "desktop", "run", "tauri", "dev"], { env: devEnv });
}
