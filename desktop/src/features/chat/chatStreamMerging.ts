import type { Message, MessageAttachment } from "../../app/types";
import type { HermesInboxMessage } from "../../types/hermes";

export function mergeStreamDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  streamMessageId: string,
  finalized: boolean,
) {
  const content = delivery.content;
  const streaming = !finalized;
  const updateMessage = (message: Message): Message => ({
    ...message,
    id: message.id || streamMessageId,
    streamMessageId,
    content: mergedStreamSnapshotContent(message.content, content),
    streaming,
  });
  const streamIndex = existing.findIndex(
    (message) => message.streamMessageId === streamMessageId || message.id === streamMessageId,
  );
  if (streamIndex !== -1) {
    return existing.map((message, index) => (index === streamIndex ? updateMessage(message) : message));
  }

  const placeholderIndex = existing.findIndex(
    (message) => message.role === "assistant" && message.streaming && !message.streamMessageId,
  );
  const assistantMessage: Message = {
    id: streamMessageId,
    role: "assistant",
    content,
    streaming,
    streamMessageId,
  };
  if (placeholderIndex !== -1) {
    return coalescePostStreamAttachments(existing.map((message, index) => (index === placeholderIndex ? assistantMessage : message)));
  }
  return coalescePostStreamAttachments([...existing, assistantMessage]);
}

export function mergeCompletedDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  replyTo: string,
) {
  const streamingIndex = lastStreamingAssistantIndex(existing);
  if (streamingIndex === -1) {
    const duplicateIndex = duplicateCompletedDeliveryIndex(existing, delivery, replyTo);
    if (duplicateIndex !== -1) {
      return coalescePostStreamAttachments(
        existing.map((message, index) =>
          index === duplicateIndex
            ? {
                ...message,
                content: mergedCompletedStreamContent(message.content, delivery.content),
                streaming: false,
              }
            : message,
        ),
      );
    }

    const attachIndex = postStreamAttachmentIndex(existing, delivery);
    if (attachIndex !== -1) {
      return coalescePostStreamAttachments(
        existing.map((message, index) =>
          index === attachIndex
            ? {
                ...message,
                content: appendMessageContent(message.content, delivery.content),
              }
            : message,
        ),
      );
    }

    const assistantMessage: Message = {
      id: delivery.id,
      role: "assistant",
      content: delivery.content,
      streaming: false,
    };
    return coalescePostStreamAttachments([
      ...existing,
      assistantMessage,
    ]);
  }

  return coalescePostStreamAttachments(
    existing.map((message, index) =>
      index === streamingIndex
        ? completedStreamingMessage(message, delivery)
        : message,
    ),
  );
}

function completedStreamingMessage(message: Message, delivery: HermesInboxMessage): Message {
  if (!message.streamMessageId) {
    return {
      ...message,
      id: delivery.id,
      content: delivery.content,
      streaming: false,
    };
  }
  return {
    ...message,
    content: mergedCompletedStreamContent(message.content, delivery.content),
    streaming: false,
  };
}

function lastStreamingAssistantIndex(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.streaming) return index;
  }
  return -1;
}

function postStreamAttachmentIndex(messages: Message[], delivery: HermesInboxMessage) {
  if (delivery.source !== "hermes-gateway" || !delivery.content.trim()) return -1;
  if (!isPostStreamAttachmentContent(delivery.content)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return -1;
    if (message.role === "assistant" && message.streamMessageId) return index;
  }
  return -1;
}

function duplicateCompletedDeliveryIndex(messages: Message[], delivery: HermesInboxMessage, replyTo: string) {
  const content = normalizeMessageContent(delivery.content);
  if (!content || isPostStreamAttachmentContent(delivery.content)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return -1;
    if (message.role !== "assistant") continue;
    const canCoalesce = Boolean(message.streamMessageId || replyTo);
    if (canCoalesce && equivalentMessageContent(message.content, delivery.content)) return index;
  }
  return -1;
}

function normalizeMessageContent(content: string) {
  return content.trim().split("\n").map((line) => line.trimEnd()).join("\n");
}

function equivalentMessageContent(left: string, right: string) {
  return compactWhitespace(left) === compactWhitespace(right);
}

function compactWhitespace(content: string) {
  return normalizeMessageContent(content)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function mergedCompletedStreamContent(existing: string, delivery: string) {
  const existingContent = existing.trimEnd();
  const deliveryContent = delivery.trim();
  if (!existingContent) return deliveryContent;
  if (!deliveryContent) return existingContent;
  if (compactWhitespace(existingContent) === compactWhitespace(deliveryContent)) return deliveryContent;
  if (compactWhitespace(deliveryContent).startsWith(compactWhitespace(existingContent))) return deliveryContent;
  if (compactWhitespace(existingContent).includes(compactWhitespace(deliveryContent))) return existingContent;
  const overlapped = overlappingMessageContent(existingContent, deliveryContent);
  if (overlapped) return overlapped;
  return appendMessageContent(existingContent, deliveryContent);
}

function mergedStreamSnapshotContent(existing: string, delivery: string) {
  const existingContent = existing.trimEnd();
  const deliveryContent = delivery.trim();
  if (!existingContent) return deliveryContent;
  if (!deliveryContent) return existingContent;
  const compactExisting = compactWhitespace(existingContent);
  const compactDelivery = compactWhitespace(deliveryContent);
  if (compactDelivery.startsWith(compactExisting)) return deliveryContent;
  if (compactExisting.startsWith(compactDelivery)) return existingContent;
  return compactDelivery.length >= compactExisting.length ? deliveryContent : existingContent;
}

function overlappingMessageContent(existing: string, delivery: string) {
  const maxOverlap = Math.min(existing.length, delivery.length);
  for (let length = maxOverlap; length > 11; length -= 1) {
    const prefix = delivery.slice(0, length);
    const index = existing.lastIndexOf(prefix);
    if (index !== -1) return `${existing.slice(0, index)}${delivery}`;
  }
  return "";
}

function appendMessageContent(content: string, addition: string) {
  const left = content.trimEnd();
  const right = addition.trim();
  if (!left) return right;
  if (!right || left.includes(right) || equivalentMessageContent(left, right)) return left;
  if (/^[,.;:!?)]/.test(right)) return `${left}${right}`;
  if (!/[.!?:;)]$/.test(left) && /^[a-z]/.test(right)) return `${left} ${right}`;
  return `${left}\n\n${right}`;
}

export function coalescePostStreamAttachments(messages: Message[]) {
  const coalesced: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const next = messages[index + 1];

    if (isPostStreamAttachmentMessage(message) && next && next.role === "assistant" && next.streamMessageId) {
      coalesced.push({
        ...next,
        content: appendMessageContent(next.content, message.content),
      });
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.streamMessageId && next && isPostStreamAttachmentMessage(next)) {
      coalesced.push({
        ...message,
        content: appendMessageContent(message.content, next.content),
      });
      index += 1;
      continue;
    }

    coalesced.push(message);
  }
  return coalesced;
}

function isPostStreamAttachmentMessage(message: Message) {
  return message.role === "assistant" && isPostStreamAttachmentContent(message.content);
}

function isPostStreamAttachmentContent(content: string) {
  const trimmed = content.trim();
  return (
    /^(?:🖼️\s*)?Image:\s+/i.test(trimmed) ||
    /^(?:📎\s*)?File:\s+/i.test(trimmed) ||
    /^Media:\s+/i.test(trimmed)
  );
}

export function deliveryCompletesActiveStream(messages: Message[], delivery: HermesInboxMessage) {
  if (delivery.source !== "hermes-gateway" || !delivery.content.trim()) return false;
  if (isPostStreamAttachmentContent(delivery.content)) return false;
  return messages.some((message) =>
    message.role === "assistant" && Boolean(message.streamMessageId) && message.streaming,
  );
}

export function mergeMessageLists(primary: Message[], secondary: Message[]) {
  const byId = new Set(primary.map((message) => message.id));
  const merged = [...primary];
  for (const message of secondary) {
    if (byId.has(message.id)) continue;
    const duplicateLocalIndex = merged.findIndex((existing) =>
      shouldReplaceLocalDuplicateMessage(existing, message),
    );
    if (duplicateLocalIndex !== -1) {
      byId.delete(merged[duplicateLocalIndex].id);
      merged[duplicateLocalIndex] = message;
      byId.add(message.id);
      continue;
    }
    byId.add(message.id);
    merged.push(message);
  }
  return merged;
}

function shouldReplaceLocalDuplicateMessage(existing: Message, incoming: Message) {
  if (!messagesRenderEquivalently(existing, incoming)) return false;
  if (isPersistedHistoryMessageId(existing.id) && isPersistedHistoryMessageId(incoming.id)) return false;
  return isLikelyLocalMessageId(existing.id) || isPersistedHistoryMessageId(incoming.id);
}

function messagesRenderEquivalently(left: Message, right: Message) {
  return left.role === right.role &&
    equivalentMessageContent(left.content, right.content) &&
    attachmentSignature(left.attachments) === attachmentSignature(right.attachments);
}

function attachmentSignature(attachments: MessageAttachment[] | undefined) {
  if (!attachments?.length) return "";
  return attachments
    .map((attachment) =>
      [
        attachment.kind,
        attachment.mimeType,
        attachment.name,
        attachment.localPath || "",
        attachment.previewUrl || "",
        attachment.downloadUrl || "",
        attachment.size,
      ].join(":"),
    )
    .sort()
    .join("|");
}

function isPersistedHistoryMessageId(messageId: string) {
  return /^\d+$/.test(messageId);
}

function isLikelyLocalMessageId(messageId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId);
}
