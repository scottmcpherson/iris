import type { HermesSession } from "../types/hermes";

export function mergeProjectSessionsForSidebar(
  projectIds: string[],
  sessionsByProject: Record<string, HermesSession[]>,
  localSessions: HermesSession[],
) {
  const knownProjectIds = new Set(projectIds);
  const merged: Record<string, HermesSession[]> = {};

  for (const projectId of projectIds) {
    merged[projectId] = [...(sessionsByProject[projectId] || [])];
  }

  for (const session of localSessions) {
    const projectId = sessionProjectId(session);
    if (!projectId || !knownProjectIds.has(projectId)) continue;
    merged[projectId] = upsertProjectSession(merged[projectId] || [], session);
  }

  return merged;
}

export function isProjectSession(
  session: HermesSession,
  projectedSessionIds: Set<string>,
) {
  return projectedSessionIds.has(session.id) || Boolean(sessionProjectId(session));
}

export function sessionProjectId(session: HermesSession) {
  const metadata = session.metadata || {};
  if (typeof metadata.projectId === "string" && metadata.projectId) return metadata.projectId;
  const project = metadata.project;
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function upsertProjectSession(
  sessions: HermesSession[],
  session: HermesSession,
) {
  const next = sessions.filter((item) =>
    item.id !== session.id &&
    (!session.chatId || item.chatId !== session.chatId)
  );
  next.push(session);
  return next.sort(
    (left, right) => sessionMillis(right.lastActiveAt) - sessionMillis(left.lastActiveAt),
  );
}

function sessionMillis(value: number | null | undefined) {
  if (!value) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}
