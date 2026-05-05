import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
const sidecarHost = process.env.HERMES_MGMT_HOST ?? "127.0.0.1";
const sidecarPort = process.env.HERMES_MGMT_PORT ?? "8765";

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

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

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
    run("sidecar", sidecarBin, ["--host", sidecarHost, "--port", sidecarPort], {
      env: {
        HERMES_MGMT_HOST: sidecarHost,
        HERMES_MGMT_PORT: sidecarPort,
      },
    });
  }
}

if (webOnly) {
  run("desktop", npm, ["--workspace", "desktop", "run", "dev"]);
} else {
  run("desktop", npm, ["--workspace", "desktop", "run", "tauri", "dev"]);
}
