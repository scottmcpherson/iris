export const storageKeys = {
  runtimeConfig: "iris.desktop.runtime.v2",
  legacyRuntimeConfig: "hermes.desktop.runtime",
  onboardingDismissed: "hermes.desktop.onboarding.dismissed",
  automationsDeliveryTarget: "hermes.desktop.automations.deliveryTarget",
  modelSelectionByProfile: "hermes.desktop.modelSelectionByProfile",
  collapsedSidebarSections: "iris.desktop.sidebar.collapsedSections",
  sidebarOrganization: "iris.desktop.sidebar.organization",
  collapsedSessionProfiles: "hermes.desktop.sidebar.collapsedSessions",
  collapsedProjects: "iris.desktop.sidebar.collapsedProjects",
  selectedProjectId: "iris.desktop.selectedProjectId",
  pinnedSessions: "hermes.desktop.sidebar.pinnedSessions",
} as const;

export function loadJsonValue<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJsonValue(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Session state is still enough when storage is unavailable.
  }
}

export function loadStringValue(key: string, fallback = "") {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function saveStringValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Session state is still enough when storage is unavailable.
  }
}

export function loadBooleanValue(key: string, fallback = false) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

export function saveBooleanValue(key: string, value: boolean) {
  saveStringValue(key, String(value));
}
