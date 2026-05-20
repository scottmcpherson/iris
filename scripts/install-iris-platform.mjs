import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hermesHome = expandHome(process.env.HERMES_HOME ?? join(homedir(), ".hermes"));
const source = join(root, "iris-platform");
const coreHost = process.env.IRIS_CORE_HOST || "127.0.0.1";
const corePort = parsePort(process.env.IRIS_CORE_PORT, 8765);
const inboundHost = process.env.IRIS_INBOUND_HOST || coreHost;
const inboundPort = parsePort(process.env.IRIS_INBOUND_PORT, 8766);

if (!existsSync(source)) {
  console.error(`Missing Iris Hermes adapter plugin source at ${source}`);
  process.exit(1);
}

const profileHomes = discoverHermesHomes(hermesHome);

const hermes = process.platform === "win32" ? "hermes.exe" : "hermes";
let failed = false;
for (const [index, profileHome] of profileHomes.entries()) {
  installForHermesHome(profileHome, index);
  const result = spawnSync(hermes, ["plugins", "enable", "iris-platform"], {
    env: {
      ...process.env,
      HERMES_HOME: profileHome,
    },
    stdio: "inherit",
  });

  if (result.error) {
    console.warn(`[iris-hermes-adapter] copied to ${profileHome}, but could not run Hermes CLI: ${result.error.message}`);
    console.warn(`Enable it manually with: HERMES_HOME="${profileHome}" hermes plugins enable iris-platform`);
    continue;
  }

  if (result.status !== 0) {
    console.warn(`[iris-hermes-adapter] copied to ${profileHome}, but Hermes CLI did not enable it successfully.`);
    console.warn(`Enable it manually with: HERMES_HOME="${profileHome}" hermes plugins enable iris-platform`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("[iris-platform] enabled in Hermes profiles. Restart the Hermes gateway before testing fresh chats.");

function installForHermesHome(profileHome, index) {
  const pluginsDir = join(profileHome, "plugins");
  const destination = join(pluginsDir, "iris-platform");
  mkdirSync(pluginsDir, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  updateEnvFile(join(profileHome, ".env"), {
    IRIS_BASE_URL: `http://${coreHost}:${corePort}`,
    IRIS_INBOUND_HOST: inboundHost,
    IRIS_INBOUND_PORT: String(inboundPort + index),
    ...(process.env.IRIS_TOKEN ? { IRIS_TOKEN: process.env.IRIS_TOKEN } : {}),
  });
  console.log(`[iris-hermes-adapter] installed to ${destination}`);
}

function discoverHermesHomes(rootHome) {
  const homes = [rootHome];
  const profilesRoot = join(rootHome, "profiles");
  if (!existsSync(profilesRoot)) return homes;
  for (const entry of readdirSync(profilesRoot).sort((left, right) => left.localeCompare(right))) {
    const profileHome = join(profilesRoot, entry);
    try {
      if (statSync(profileHome).isDirectory()) homes.push(profileHome);
    } catch {
      // Ignore entries that disappear while installing.
    }
  }
  return homes;
}

function updateEnvFile(path, values) {
  const existing = existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/) : [];
  const managedKeys = new Set(Object.keys(values));
  const nextLines = existing.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !managedKeys.has(match[1]);
  });
  for (const [key, value] of Object.entries(values)) {
    if (value) nextLines.push(`${key}=${shellEnvValue(String(value))}`);
  }
  writeFileSync(path, `${nextLines.filter(Boolean).join("\n")}\n`, "utf-8");
}

function shellEnvValue(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}
