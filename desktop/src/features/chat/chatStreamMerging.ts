import type { AttachmentKind, Message, MessageAttachment } from "../../app/types";
import type { HermesInboxMessage } from "../../types/hermes";

const attachmentKinds = new Set<AttachmentKind>(["image", "document", "audio", "video", "archive", "code", "file"]);

export function mergeStreamDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  streamMessageId: string,
  finalized: boolean,
) {
  const deliveryAttachments = attachmentsFromDelivery(delivery);
  const content = contentWithoutRenderedAttachmentMarkers(delivery.content, deliveryAttachments, delivery.metadata);
  const streaming = !finalized;
  const updateMessage = (message: Message): Message => ({
    ...message,
    id: message.id || streamMessageId,
    streamMessageId,
    content: finalized && deliveryAttachments.length && content.trim()
      ? content
      : mergedStreamSnapshotContent(message.content, content),
    attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
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
    attachments: deliveryAttachments.length ? deliveryAttachments : undefined,
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
  const deliveryAttachments = attachmentsFromDelivery(delivery);
  const deliveryContent = contentWithoutRenderedAttachmentMarkers(delivery.content, deliveryAttachments, delivery.metadata);
  const streamingIndex = lastStreamingAssistantIndex(existing);
  if (streamingIndex === -1) {
    const duplicateIndex = duplicateCompletedDeliveryIndex(existing, delivery, replyTo);
    if (duplicateIndex !== -1) {
      return coalescePostStreamAttachments(
        existing.map((message, index) =>
          index === duplicateIndex
            ? {
                ...message,
                content: mergedCompletedStreamContent(message.content, deliveryContent),
                attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
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
                content: appendMessageContent(message.content, deliveryContent),
                attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
              }
            : message,
        ),
      );
    }

    const assistantMessage: Message = {
      id: delivery.id,
      role: "assistant",
      content: deliveryContent,
      ...(delivery.source === "hermes-cron" ? { source: delivery.source } : {}),
      streaming: false,
      attachments: deliveryAttachments.length ? deliveryAttachments : undefined,
    };
    return coalescePostStreamAttachments([
      ...existing,
      assistantMessage,
    ]);
  }

  return coalescePostStreamAttachments(
    existing.map((message, index) =>
      index === streamingIndex
        ? completedStreamingMessage(message, delivery, deliveryContent, deliveryAttachments)
        : message,
    ),
  );
}

function completedStreamingMessage(
  message: Message,
  delivery: HermesInboxMessage,
  deliveryContent: string,
  deliveryAttachments: MessageAttachment[],
): Message {
  if (!message.streamMessageId) {
    return {
      ...message,
      id: delivery.id,
      content: deliveryContent,
      attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
      streaming: false,
    };
  }
  return {
    ...message,
    content: mergedCompletedStreamContent(message.content, deliveryContent),
    attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
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
  if (delivery.source !== "hermes-gateway" || (!delivery.content.trim() && !attachmentsFromDelivery(delivery).length)) return -1;
  if (!isPostStreamAttachmentContent(delivery.content) && !attachmentsFromDelivery(delivery).length) return -1;
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
        content: appendMessageContent(next.content, contentWithoutRenderedAttachmentMarkers(message.content, message.attachments)),
        attachments: mergeMessageAttachments(next.attachments, message.attachments),
      });
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.streamMessageId && next && isPostStreamAttachmentMessage(next)) {
      coalesced.push({
        ...message,
        content: appendMessageContent(message.content, contentWithoutRenderedAttachmentMarkers(next.content, next.attachments)),
        attachments: mergeMessageAttachments(message.attachments, next.attachments),
      });
      index += 1;
      continue;
    }

    coalesced.push(message);
  }
  return coalesced;
}

function isPostStreamAttachmentMessage(message: Message) {
  return message.role === "assistant" && (isPostStreamAttachmentContent(message.content) || Boolean(message.attachments?.length));
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

export function attachmentsFromDelivery(delivery: HermesInboxMessage): MessageAttachment[] {
  return attachmentsFromMetadata(delivery.metadata);
}

export function attachmentsFromMetadata(metadata: Record<string, unknown> | undefined): MessageAttachment[] {
  if (!metadata || !Array.isArray(metadata.attachments)) return [];
  return metadata.attachments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" && candidate.id ? candidate.id : crypto.randomUUID();
    const name = typeof candidate.name === "string" && candidate.name ? candidate.name : "Attached file";
    const kind = attachmentKind(candidate.kind);
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "";
    const size = typeof candidate.size === "number" ? candidate.size : -1;
    const lastModified = typeof candidate.lastModified === "number" ? candidate.lastModified : 0;
    const previewUrl = typeof candidate.previewUrl === "string" ? candidate.previewUrl : undefined;
    const downloadUrl = typeof candidate.downloadUrl === "string" ? candidate.downloadUrl : undefined;
    const localPath = typeof candidate.localPath === "string"
      ? candidate.localPath
      : typeof candidate.path === "string"
        ? candidate.path
        : undefined;
    const legacyLocalPath = candidate.legacyLocalPath === true || (Boolean(localPath) && !previewUrl);
    return [{ id, name, kind, mimeType, size, lastModified, previewUrl, downloadUrl, localPath, legacyLocalPath }];
  });
}

export function mergeMessageAttachments(
  left: MessageAttachment[] | undefined,
  right: MessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
  const merged: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of [...(left || []), ...(right || [])]) {
    const sha256 = typeof (attachment as unknown as Record<string, unknown>).sha256 === "string"
      ? String((attachment as unknown as Record<string, unknown>).sha256)
      : "";
    const key = attachment.id || sha256 || attachment.downloadUrl || attachment.previewUrl || attachment.localPath || attachment.name;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(attachment);
  }
  return merged.length ? merged : undefined;
}

export function contentWithoutRenderedAttachmentMarkers(
  content: string,
  attachments: MessageAttachment[] | undefined,
  metadata: Record<string, unknown> | undefined = undefined,
) {
  if (!attachments?.length) return content;
  const generatedPaths = new Set(generatedFilePaths(metadata));
  const attachmentNames = new Set(attachments.map((attachment) => attachment.name).filter(Boolean));
  const lines = content.split("\n").filter((line) => {
    const marker = generatedFileMarkerValue(line);
    if (!marker) return true;
    if (generatedPaths.has(marker)) return false;
    const markerName = marker.split(/[\\/]/).pop() || marker;
    return !attachmentNames.has(markerName);
  });
  return lines.join("\n").trim();
}

function attachmentKind(value: unknown): AttachmentKind {
  return typeof value === "string" && attachmentKinds.has(value as AttachmentKind)
    ? value as AttachmentKind
    : "file";
}

function generatedFilePaths(metadata: Record<string, unknown> | undefined) {
  if (!metadata || !Array.isArray(metadata.generatedFiles)) return [];
  return metadata.generatedFiles.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = (item as Record<string, unknown>).path;
    return typeof value === "string" && value ? [value] : [];
  });
}

function generatedFileMarkerValue(line: string) {
  const match = line.match(/^\s*(?:Generated\s+file:\s*)?(?:[^\w\s/\\.:~-]+\s*)?(?:MEDIA|Media|Image|File):\s*(.+?)\s*$/);
  if (!match) return "";
  const value = match[1].trim().replace(/^file:\/\/(?:localhost)?/, "");
  if (!value.startsWith("/") && !/^file:\/\//.test(match[1].trim())) return "";
  return value;
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
