import { execFileSync } from "node:child_process";

const commands = [
  ["npm", ["run", "build"]],
  ["cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["npm", ["run", "tauri", "info"]],
];

for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

console.log("\nPackaging checks completed for this host. CI runs the same checks on macOS, Windows, and Linux.");
