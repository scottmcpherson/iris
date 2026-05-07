import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hermesHome = expandHome(process.env.HERMES_HOME ?? join(homedir(), ".hermes"));
const source = join(root, "agentui-platform");

if (!existsSync(source)) {
  console.error(`Missing Iris Hermes adapter plugin source at ${source}`);
  process.exit(1);
}

const profileHomes = discoverHermesHomes(hermesHome);

const hermes = process.platform === "win32" ? "hermes.exe" : "hermes";
let failed = false;
for (const profileHome of profileHomes) {
  installForHermesHome(profileHome);
  const result = spawnSync(hermes, ["plugins", "enable", "agentui-platform"], {
    env: {
      ...process.env,
      HERMES_HOME: profileHome,
    },
    stdio: "inherit",
  });

  if (result.error) {
    console.warn(`[iris-hermes-adapter] copied to ${profileHome}, but could not run Hermes CLI: ${result.error.message}`);
    console.warn(`Enable it manually with: HERMES_HOME="${profileHome}" hermes plugins enable agentui-platform`);
    continue;
  }

  if (result.status !== 0) {
    console.warn(`[iris-hermes-adapter] copied to ${profileHome}, but Hermes CLI did not enable it successfully.`);
    console.warn(`Enable it manually with: HERMES_HOME="${profileHome}" hermes plugins enable agentui-platform`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("[agentui-platform] enabled in Hermes profiles.");

function installForHermesHome(profileHome) {
  const pluginsDir = join(profileHome, "plugins");
  const destination = join(pluginsDir, "agentui-platform");
  mkdirSync(pluginsDir, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  console.log(`[iris-hermes-adapter] installed to ${destination}`);
}

function discoverHermesHomes(rootHome) {
  const homes = [rootHome];
  const profilesRoot = join(rootHome, "profiles");
  if (!existsSync(profilesRoot)) return homes;
  for (const entry of readdirSync(profilesRoot)) {
    const profileHome = join(profilesRoot, entry);
    try {
      if (statSync(profileHome).isDirectory()) homes.push(profileHome);
    } catch {
      // Ignore entries that disappear while installing.
    }
  }
  return homes;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}
