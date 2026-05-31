const required = [
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_SIGNING_IDENTITY",
  "TAURI_SIGNING_PRIVATE_KEY",
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`Missing macOS release environment variables: ${missing.join(", ")}`);
  console.error(
    "Set the Apple signing/notarization credentials and the Tauri updater signing key (TAURI_SIGNING_PRIVATE_KEY, e.g. ~/.tauri/iris-updater.key) before running release:mac.",
  );
  process.exit(1);
}

console.log("macOS signing and notarization environment is present.");
