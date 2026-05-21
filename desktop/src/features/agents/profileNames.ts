const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PROFILE_NAMES = new Set(["hermes", "test", "tmp", "root", "sudo"]);

export function normalizeProfileName(value: string) {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "default" ? "default" : trimmed.toLowerCase();
}

export function profileNameError(value: string, options: { allowDefault?: boolean } = {}) {
  const name = normalizeProfileName(value);
  if (!name) return "Enter an agent name.";
  if (name === "default" && options.allowDefault !== true) {
    return "default is the built-in Hermes profile.";
  }
  if (name !== "default" && !PROFILE_NAME_RE.test(name)) {
    return "Use lowercase letters, numbers, dashes, or underscores.";
  }
  if (RESERVED_PROFILE_NAMES.has(name)) {
    return `${name} is reserved by Hermes.`;
  }
  return "";
}
