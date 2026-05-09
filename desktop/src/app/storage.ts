export const storageKeys = {
  runtimeConfig: "hermes.desktop.runtime",
  onboardingDismissed: "hermes.desktop.onboarding.dismissed",
  previewOpen: "hermes.desktop.preview.open",
  previewArtifacts: "hermes.preview.artifacts.v1",
  jobsDeliveryTarget: "hermes.desktop.jobs.deliveryTarget",
  memoryProviders: "hermes-memory-provider-controls",
  modelSelectionByProfile: "hermes.desktop.modelSelectionByProfile",
  collapsedSidebarSections: "iris.desktop.sidebar.collapsedSections",
  collapsedSessionProfiles: "hermes.desktop.sidebar.collapsedSessions",
  collapsedProjects: "iris.desktop.sidebar.collapsedProjects",
  selectedProjectId: "iris.desktop.selectedProjectId",
  pinnedConversations: "hermes.desktop.sidebar.pinnedConversations",
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
