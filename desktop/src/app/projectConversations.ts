import type { HermesConversation } from "../types/hermes";

export function mergeProjectConversationsForSidebar(
  projectIds: string[],
  conversationsByProject: Record<string, HermesConversation[]>,
  localConversations: HermesConversation[],
) {
  const knownProjectIds = new Set(projectIds);
  const merged: Record<string, HermesConversation[]> = {};

  for (const projectId of projectIds) {
    merged[projectId] = [...(conversationsByProject[projectId] || [])];
  }

  for (const conversation of localConversations) {
    const projectId = conversationProjectId(conversation);
    if (!projectId || !knownProjectIds.has(projectId)) continue;
    merged[projectId] = upsertProjectConversation(merged[projectId] || [], conversation);
  }

  return merged;
}

export function isProjectConversation(
  conversation: HermesConversation,
  projectedConversationIds: Set<string>,
) {
  return projectedConversationIds.has(conversation.id) || Boolean(conversationProjectId(conversation));
}

export function conversationProjectId(conversation: HermesConversation) {
  const metadata = conversation.metadata || {};
  if (typeof metadata.projectId === "string" && metadata.projectId) return metadata.projectId;
  const project = metadata.project;
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function upsertProjectConversation(
  conversations: HermesConversation[],
  conversation: HermesConversation,
) {
  const next = conversations.filter((item) =>
    item.id !== conversation.id &&
    (!conversation.chatId || item.chatId !== conversation.chatId)
  );
  next.push(conversation);
  return next.sort(
    (left, right) => conversationMillis(right.lastActiveAt) - conversationMillis(left.lastActiveAt),
  );
}

function conversationMillis(value: number | null | undefined) {
  if (!value) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}
