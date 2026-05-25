import type { IrisCoreSession, IrisProject } from "@iris/core-client";

export const MOBILE_SIDEBAR_PINNED_STORAGE_KEY = "hermes.desktop.sidebar.pinnedSessions";
export const MOBILE_SIDEBAR_COLLAPSED_PROJECTS_STORAGE_KEY = "iris.desktop.sidebar.collapsedProjects";
export const MOBILE_SIDEBAR_COLLAPSED_SECTIONS_STORAGE_KEY = "iris.desktop.sidebar.collapsedSections";
const DEFAULT_PROFILE = "default";

export type MobileSidebarSectionId = "pinned" | "projects" | "chats";
type DesktopSidebarSectionId = MobileSidebarSectionId | "agents";
type MobileSidebarStorage = Pick<Storage, "getItem" | "setItem">;

export type MobileSidebarProjectNode = {
  project: IrisProject;
  sessions: IrisCoreSession[];
};

export type MobileSidebarPinnedSession = {
  pinKey: string;
  profileName: string;
  session: IrisCoreSession;
};

export type MobileSidebarModel = {
  pinnedSessions: MobileSidebarPinnedSession[];
  projectNodes: MobileSidebarProjectNode[];
  unprojectedSessions: IrisCoreSession[];
};

export type MobileSidebarCollapsedSections = Record<DesktopSidebarSectionId, boolean>;

const memoryStorageValues: Record<string, string> = {};
const memoryStorage: MobileSidebarStorage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(memoryStorageValues, key) ? memoryStorageValues[key] : null;
  },
  setItem(key, value) {
    memoryStorageValues[key] = value;
  },
};

export function buildMobileSidebarModel({
  pinnedSessions,
  projects,
  sessions,
  sessionsByProject,
}: {
  pinnedSessions: Record<string, boolean>;
  projects: IrisProject[];
  sessions: IrisCoreSession[];
  sessionsByProject: Record<string, IrisCoreSession[]>;
}): MobileSidebarModel {
  const mergedSessionsByProject = mergeProjectSessionsForMobile(
    projects.map((project) => project.id),
    sessionsByProject,
    sessions,
  );
  const membership = projectSessionMembership(mergedSessionsByProject);
  const unprojectedSessions = sortSessions(
    sessions.filter((session) => !isProjectSession(session, membership)),
  );

  const pinnedItems = buildPinnedSessionItems({
    pinnedSessions,
    projects,
    sessions,
    sessionsByProject: mergedSessionsByProject,
    unprojectedSessions,
  });

  return {
    pinnedSessions: pinnedItems,
    projectNodes: projects.map((project) => ({
      project,
      sessions: (mergedSessionsByProject[project.id] || []).filter((session) => {
        const profileName = runtimeProfileForSession(session);
        return !pinnedPinKeyForSessionItem({
          pinKey: projectSessionPinKey(project.id, session.id),
          profileName,
          session,
        }, pinnedSessions);
      }),
    })),
    unprojectedSessions: unprojectedSessions.filter((session) => {
      const profileName = runtimeProfileForSession(session);
      return !pinnedPinKeyForSessionItem({
        pinKey: unprojectedSessionPinKey(profileName, session.id),
        profileName,
        session,
      }, pinnedSessions);
    }),
  };
}

export function loadMobileSidebarPinnedSessions(
  storage: Pick<Storage, "getItem"> | null | undefined = browserStorage(),
) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(MOBILE_SIDEBAR_PINNED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return normalizePinnedSessions(parsed);
  } catch {
    return {};
  }
}

export function saveMobileSidebarPinnedSessions(
  pinnedSessions: Record<string, boolean>,
  storage: Pick<Storage, "setItem"> | null | undefined = browserStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(MOBILE_SIDEBAR_PINNED_STORAGE_KEY, JSON.stringify(pinnedSessions));
  } catch {
    // In-memory state is enough when browser storage is unavailable.
  }
}

export function loadMobileSidebarCollapsedProjects(
  storage: Pick<Storage, "getItem"> | null | undefined = browserStorage(),
) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(MOBILE_SIDEBAR_COLLAPSED_PROJECTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return normalizeBooleanRecord(parsed);
  } catch {
    return {};
  }
}

export function saveMobileSidebarCollapsedProjects(
  collapsedProjects: Record<string, boolean>,
  storage: Pick<Storage, "setItem"> | null | undefined = browserStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(MOBILE_SIDEBAR_COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify(collapsedProjects));
  } catch {
    // In-memory state is enough when browser storage is unavailable.
  }
}

export function loadMobileSidebarCollapsedSections(
  storage: Pick<Storage, "getItem"> | null | undefined = browserStorage(),
): MobileSidebarCollapsedSections {
  if (!storage) return defaultCollapsedSections();
  try {
    const raw = storage.getItem(MOBILE_SIDEBAR_COLLAPSED_SECTIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return normalizeCollapsedSections(parsed);
  } catch {
    return defaultCollapsedSections();
  }
}

export function saveMobileSidebarCollapsedSections(
  collapsedSections: MobileSidebarCollapsedSections,
  storage: Pick<Storage, "setItem"> | null | undefined = browserStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(MOBILE_SIDEBAR_COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify(collapsedSections));
  } catch {
    // In-memory state is enough when browser storage is unavailable.
  }
}

export function mobileSidebarTimeLabel(value: number | null | undefined) {
  if (!value) return "Unknown";
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  const delta = Date.now() - millis;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "now";
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  if (delta < 14 * day) return `${Math.floor(delta / day)}d`;
  return new Date(millis).toLocaleDateString();
}

export function sessionProjectId(session: IrisCoreSession) {
  const metadata = session.metadata || {};
  if (typeof metadata.projectId === "string" && metadata.projectId) return metadata.projectId;
  const project = metadata.project;
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

export function agentSessionPinKey(profileName: string, sessionId: string) {
  return `agent:${profileName}:${sessionId}`;
}

export function projectSessionPinKey(projectId: string, sessionId: string) {
  return `project:${projectId}:${sessionId}`;
}

export function unprojectedSessionPinKey(profileName: string, sessionId: string) {
  return `chat:${profileName}:${sessionId}`;
}

function buildPinnedSessionItems({
  pinnedSessions,
  projects,
  sessions,
  sessionsByProject,
  unprojectedSessions,
}: {
  pinnedSessions: Record<string, boolean>;
  projects: IrisProject[];
  sessions: IrisCoreSession[];
  sessionsByProject: Record<string, IrisCoreSession[]>;
  unprojectedSessions: IrisCoreSession[];
}) {
  const seen = new Set<string>();
  const items: MobileSidebarPinnedSession[] = [];

  function pushItem(item: Omit<MobileSidebarPinnedSession, "pinKey"> & { pinKey: string }) {
    const pinnedKey = pinnedPinKeyForSessionItem(item, pinnedSessions);
    const identityKey = `${item.profileName}:${item.session.id}`;
    if (!pinnedKey || seen.has(identityKey)) return;
    seen.add(identityKey);
    items.push({ ...item, pinKey: pinnedKey });
  }

  for (const project of projects) {
    for (const session of sessionsByProject[project.id] || []) {
      pushItem({
        pinKey: projectSessionPinKey(project.id, session.id),
        profileName: runtimeProfileForSession(session),
        session,
      });
    }
  }

  for (const session of unprojectedSessions) {
    const profileName = runtimeProfileForSession(session);
    pushItem({
      pinKey: unprojectedSessionPinKey(profileName, session.id),
      profileName,
      session,
    });
  }

  for (const session of sessions) {
    const profileName = runtimeProfileForSession(session);
    pushItem({
      pinKey: agentSessionPinKey(profileName, session.id),
      profileName,
      session,
    });
  }

  return items.sort(
    (left, right) => sessionActivitySeconds(right.session) - sessionActivitySeconds(left.session),
  );
}

function mergeProjectSessionsForMobile(
  projectIds: string[],
  sessionsByProject: Record<string, IrisCoreSession[]>,
  localSessions: IrisCoreSession[],
) {
  const knownProjectIds = new Set(projectIds);
  const merged: Record<string, IrisCoreSession[]> = {};

  for (const projectId of projectIds) {
    merged[projectId] = sortSessions(deduplicateSessions(sessionsByProject[projectId] || []));
  }

  for (const session of localSessions) {
    const projectId = sessionProjectId(session);
    if (!projectId || !knownProjectIds.has(projectId)) continue;
    merged[projectId] = upsertProjectSession(merged[projectId] || [], session);
  }

  return merged;
}

function projectSessionMembership(sessionsByProject: Record<string, IrisCoreSession[]>) {
  const ids = new Set<string>();
  const externalChatIds = new Set<string>();
  const externalSessionIds = new Set<string>();
  for (const sessions of Object.values(sessionsByProject)) {
    for (const session of sessions) {
      ids.add(session.id);
      if (session.externalChatId) externalChatIds.add(session.externalChatId);
      if (session.externalSessionId) externalSessionIds.add(session.externalSessionId);
    }
  }
  return { externalChatIds, externalSessionIds, ids };
}

function isProjectSession(
  session: IrisCoreSession,
  membership: ReturnType<typeof projectSessionMembership>,
) {
  return membership.ids.has(session.id) ||
    Boolean(session.externalChatId && membership.externalChatIds.has(session.externalChatId)) ||
    Boolean(session.externalSessionId && membership.externalSessionIds.has(session.externalSessionId)) ||
    Boolean(sessionProjectId(session));
}

function pinnedPinKeyForSessionItem(
  item: {
    pinKey: string;
    profileName: string;
    session: IrisCoreSession;
  },
  pinnedSessions: Record<string, boolean>,
) {
  const candidates = [
    item.pinKey,
    agentSessionPinKey(item.profileName, item.session.id),
    unprojectedSessionPinKey(item.profileName, item.session.id),
    legacySessionPinKey(item.profileName, item.session.id),
  ];

  return candidates.find((pinKey) => pinnedSessions[pinKey]) || "";
}

function upsertProjectSession(
  sessions: IrisCoreSession[],
  session: IrisCoreSession,
) {
  const next = sessions.filter((item) =>
    item.id !== session.id &&
    (!session.externalChatId || item.externalChatId !== session.externalChatId) &&
    (!session.externalSessionId || item.externalSessionId !== session.externalSessionId)
  );
  next.push(session);
  return sortSessions(next);
}

function deduplicateSessions(sessions: IrisCoreSession[]) {
  return sessions.reduce<IrisCoreSession[]>((items, session) => upsertProjectSession(items, session), []);
}

function sortSessions(sessions: IrisCoreSession[]) {
  return [...sessions].sort(
    (left, right) => sessionActivitySeconds(right) - sessionActivitySeconds(left),
  );
}

function sessionActivitySeconds(session: IrisCoreSession) {
  return session.updatedAt || session.createdAt || 0;
}

export function runtimeProfileForSession(session: IrisCoreSession, fallback = DEFAULT_PROFILE) {
  const origin = session.origin || {};
  const metadata = session.metadata || {};
  return String(
    origin.runtimeProfile ||
      metadata.runtimeProfile ||
      session.runtimeProfile ||
      fallback ||
      DEFAULT_PROFILE,
  );
}

function legacySessionPinKey(profileName: string, sessionId: string) {
  return `${profileName}:${sessionId}`;
}

function normalizePinnedSessions(parsed: unknown) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([key]) => key.includes(":"))
      .map(([key, value]) => [key, Boolean(value)]),
  );
}

function normalizeBooleanRecord(parsed: unknown) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, Boolean(value)]),
  );
}

function normalizeCollapsedSections(parsed: unknown): MobileSidebarCollapsedSections {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaultCollapsedSections();
  }
  const record = parsed as Record<string, unknown>;
  return {
    pinned: Boolean(record.pinned),
    projects: Boolean(record.projects),
    chats: Boolean(record.chats),
    agents: Boolean(record.agents),
  };
}

function defaultCollapsedSections(): MobileSidebarCollapsedSections {
  return {
    pinned: false,
    projects: false,
    chats: false,
    agents: false,
  };
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return memoryStorage;
  try {
    return window.localStorage || memoryStorage;
  } catch {
    return memoryStorage;
  }
}
