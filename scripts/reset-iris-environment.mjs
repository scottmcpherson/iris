import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pluginName = "iris-platform";

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run with --help for usage.");
  process.exit(2);
}
const hermesHome = normalizeHermesHome(args.hermesHome ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes"));
const irisHome = resolve(expandHome(args.irisHome ?? join(homedir(), ".iris")));
const profileHomes = discoverHermesHomes(hermesHome);
const hermes = process.platform === "win32" ? "hermes.exe" : "hermes";

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.dryRun && !args.yes) {
  console.error("Refusing to reset without --yes. Re-run with --dry-run to preview or --yes to make changes.");
  printPlan();
  process.exit(2);
}

printPlan();

let cliWarnings = 0;
for (const profileHome of profileHomes) {
  if (!args.skipHermesCli) {
    const result = runHermesRemove(profileHome);
    if (!result.ok) {
      cliWarnings += 1;
      console.warn(`[iris-reset] Hermes CLI did not remove ${pluginName} for ${profileHome}: ${result.message}`);
    }
  }
  removePluginDirectory(profileHome);
  scrubEnvFile(join(profileHome, ".env"));
}

removeIrisHome();

if (cliWarnings > 0) {
  console.warn(`[iris-reset] Completed with ${cliWarnings} Hermes CLI warning(s); file cleanup still ran.`);
}
console.log(args.dryRun ? "[iris-reset] Dry run complete." : "[iris-reset] Iris environment reset complete. Restart Hermes before testing a clean Iris install.");

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    help: false,
    hermesHome: null,
    irisHome: null,
    skipHermesCli: false,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--hermes-home") {
      parsed.hermesHome = requiredValue(argv, ++index, arg);
    } else if (arg.startsWith("--hermes-home=")) {
      parsed.hermesHome = arg.slice("--hermes-home=".length);
    } else if (arg === "--iris-home") {
      parsed.irisHome = requiredValue(argv, ++index, arg);
    } else if (arg.startsWith("--iris-home=")) {
      parsed.irisHome = arg.slice("--iris-home=".length);
    } else if (arg === "--skip-hermes-cli") {
      parsed.skipHermesCli = true;
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`
Reset local Hermes/Iris state for first-install testing.

Usage:
  npm run iris:reset -- --dry-run
  npm run iris:reset -- --yes

Options:
  --dry-run             Print what would be removed without changing files.
  --yes, -y             Confirm destructive reset.
  --hermes-home <path>  Hermes root profile. Defaults to HERMES_HOME or ~/.hermes.
  --iris-home <path>    Iris data directory. Defaults to ~/.iris.
  --skip-hermes-cli     Skip "hermes plugins remove" and only remove files/env keys.
  --help, -h            Show this help.
`.trim());
}

function printPlan() {
  console.log("[iris-reset] Hermes homes:");
  for (const profileHome of profileHomes) {
    console.log(`  - ${profileHome}`);
  }
  console.log(`[iris-reset] Iris data directory: ${irisHome}`);
  console.log(`[iris-reset] Mode: ${args.dryRun ? "dry run" : "destructive reset"}`);
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
      // Ignore profiles that disappear while the reset is running.
    }
  }

  return homes;
}

function runHermesRemove(profileHome) {
  if (args.dryRun) {
    console.log(`[iris-reset] would run: HERMES_HOME="${profileHome}" ${hermes} plugins remove ${pluginName}`);
    return { ok: true };
  }

  const result = spawnSync(hermes, ["plugins", "remove", pluginName], {
    env: {
      ...process.env,
      HERMES_HOME: profileHome,
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status === 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) console.log(output);
    return { ok: true };
  }

  return {
    ok: false,
    message: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
  };
}

function removePluginDirectory(profileHome) {
  const pluginPath = join(profileHome, "plugins", pluginName);
  if (!existsSync(pluginPath)) {
    console.log(`[iris-reset] ${pluginPath} does not exist.`);
    return;
  }
  if (args.dryRun) {
    console.log(`[iris-reset] would remove ${pluginPath}`);
    return;
  }
  rmSync(pluginPath, { recursive: true, force: true });
  console.log(`[iris-reset] removed ${pluginPath}`);
}

function scrubEnvFile(envPath) {
  if (!existsSync(envPath)) {
    console.log(`[iris-reset] ${envPath} does not exist.`);
    return;
  }

  const original = readFileSync(envPath, "utf-8");
  const lines = original.split(/\r?\n/);
  const nextLines = lines.filter((line) => !isIrisEnvLine(line));
  const changed = nextLines.length !== lines.length;

  if (!changed) {
    console.log(`[iris-reset] no Iris env keys found in ${envPath}`);
    return;
  }

  const nextText = normalizeEnvText(nextLines);
  if (args.dryRun) {
    console.log(`[iris-reset] would remove Iris env keys from ${envPath}`);
    return;
  }

  if (nextText.trim()) {
    writeFileSync(envPath, nextText, "utf-8");
    console.log(`[iris-reset] removed Iris env keys from ${envPath}`);
  } else {
    rmSync(envPath, { force: true });
    console.log(`[iris-reset] removed empty ${envPath}`);
  }
}

function isIrisEnvLine(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return Boolean(match && match[1].startsWith("IRIS_"));
}

function normalizeEnvText(lines) {
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function removeIrisHome() {
  if (!existsSync(irisHome)) {
    console.log(`[iris-reset] ${irisHome} does not exist.`);
    return;
  }
  if (args.dryRun) {
    console.log(`[iris-reset] would remove ${irisHome}`);
    return;
  }
  rmSync(irisHome, { recursive: true, force: true });
  console.log(`[iris-reset] removed ${irisHome}`);
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function normalizeHermesHome(value) {
  const path = resolve(expandHome(value));
  const parent = dirname(path);
  if (basename(parent) === "profiles") {
    return dirname(parent);
  }
  return path;
}
