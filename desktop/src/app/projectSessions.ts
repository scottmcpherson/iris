import type { HermesSession, HermesSessionReadState } from "../types/hermes";

type SessionReadStateMap = Record<string, "read" | "unread">;
type ProjectSessionMergeOptions = {
  preserveProjectSessionIds?: Set<string>;
};

export function mergeProjectSessionsForSidebar(
  projectIds: string[],
  sessionsByProject: Record<string, HermesSession[]>,
  localSessions: HermesSession[],
  options: ProjectSessionMergeOptions = {},
) {
  const knownProjectIds = new Set(projectIds);
  const merged: Record<string, HermesSession[]> = {};
  const localById = new Map(localSessions.map((session) => [session.id, session]));
  const localByChatId = new Map(
    localSessions
      .filter((session) => session.chatId)
      .map((session) => [session.chatId, session]),
  );

  for (const projectId of projectIds) {
    merged[projectId] = (sessionsByProject[projectId] || []).reduce<HermesSession[]>((items, session) => {
      const localSession = localById.get(session.id) || (session.chatId ? localByChatId.get(session.chatId) : null);
      const preserveProjectIdentity = Boolean(options.preserveProjectSessionIds?.has(session.id));
      return upsertProjectSession(
        items,
        localSession
          ? mergeProjectSession(session, localSession, { preserveProjectIdentity })
          : session,
      );
    }, []);
  }

  for (const session of localSessions) {
    const projectId = sessionProjectId(session);
    if (!projectId || !knownProjectIds.has(projectId)) continue;
    const projectSessions = merged[projectId] || [];
    const existingProjectSession = matchingProjectSession(projectSessions, session);
    const preserveProjectIdentity = Boolean(
      existingProjectSession &&
        options.preserveProjectSessionIds?.has(existingProjectSession.id),
    );
    merged[projectId] = upsertProjectSession(
      projectSessions,
      existingProjectSession
        ? mergeProjectSession(existingProjectSession, session, { preserveProjectIdentity })
        : session,
    );
  }

  return merged;
}

export function isProjectSession(
  session: HermesSession,
  projectedSessionIds: Set<string>,
  projectedChatIds: Set<string> = new Set(),
) {
  return projectedSessionIds.has(session.id) ||
    Boolean(session.chatId && projectedChatIds.has(session.chatId)) ||
    Boolean(sessionProjectId(session));
}

export function projectSessionMembership(sessionsByProject: Record<string, HermesSession[]>) {
  const ids = new Set<string>();
  const chatIds = new Set<string>();
  for (const sessions of Object.values(sessionsByProject)) {
    for (const session of sessions) {
      ids.add(session.id);
      if (session.chatId) chatIds.add(session.chatId);
    }
  }
  return { ids, chatIds };
}

export function mergeProjectSessionReadStatesForSidebar(
  current: SessionReadStateMap,
  sessionsByProject: Record<string, HermesSession[]>,
) {
  let next = current;
  for (const sessions of Object.values(sessionsByProject)) {
    for (const session of sessions) {
      const state = session.readState?.state;
      if (!state || !isStoredReadState(session.readState)) continue;
      if (next[session.id] === state) continue;
      if (next === current) next = { ...current };
      next[session.id] = state;
    }
  }
  return next;
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

function matchingProjectSession(sessions: HermesSession[], session: HermesSession) {
  return sessions.find((item) =>
    item.id === session.id ||
    Boolean(session.chatId && item.chatId === session.chatId)
  );
}

function mergeProjectSession(
  projectSession: HermesSession,
  localSession: HermesSession,
  options: { preserveProjectIdentity?: boolean } = {},
) {
  const sessionId = options.preserveProjectIdentity ? projectSession.id : localSession.id;
  const baseSession = options.preserveProjectIdentity
    ? { ...localSession, id: projectSession.id }
    : { ...projectSession, ...localSession };

  return {
    ...baseSession,
    metadata: {
      ...(localSession.metadata || {}),
      ...(projectSession.metadata || {}),
    },
    readState: mergeRelatedReadState(projectSession.readState, localSession.readState, sessionId),
  };
}

function mergeRelatedReadState(
  projectReadState: HermesSessionReadState | undefined,
  localReadState: HermesSessionReadState | undefined,
  sessionId: string,
) {
  const readState = selectRelatedReadState(projectReadState, localReadState);
  return readState ? { ...readState, sessionId } : undefined;
}

function selectRelatedReadState(
  projectReadState: HermesSessionReadState | undefined,
  localReadState: HermesSessionReadState | undefined,
) {
  if (!projectReadState) return localReadState;
  if (!localReadState) return projectReadState;
  if (projectReadState.state === localReadState.state) {
    return readStateUpdatedAt(projectReadState) > readStateUpdatedAt(localReadState)
      ? projectReadState
      : localReadState;
  }

  const readState = projectReadState.state === "read" ? projectReadState : localReadState;
  const unreadState = projectReadState.state === "unread" ? projectReadState : localReadState;
  const readCursor = readStateEventCursor(readState);
  const unreadCursor = readStateEventCursor(unreadState);
  if (readCursor !== null && unreadCursor !== null) {
    return readCursor >= unreadCursor ? readState : unreadState;
  }

  const readUpdatedAt = readStateUpdatedAt(readState);
  const unreadUpdatedAt = readStateUpdatedAt(unreadState);
  if (readUpdatedAt || unreadUpdatedAt) {
    return readUpdatedAt >= unreadUpdatedAt ? readState : unreadState;
  }
  return unreadState;
}

function isStoredReadState(readState: HermesSessionReadState | undefined) {
  if (!readState) return false;
  return Boolean(
    readState.createdAt ||
      readState.updatedAt ||
      Object.keys(readState.metadata || {}).length,
  );
}

function readStateUpdatedAt(readState: HermesSessionReadState) {
  return readState.updatedAt || readState.createdAt || 0;
}

function readStateEventCursor(readState: HermesSessionReadState) {
  const value = readState.metadata?.eventCursor;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sessionMillis(value: number | null | undefined) {
  if (!value) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}
