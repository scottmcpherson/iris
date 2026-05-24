import type { AttachmentKind, ChatMessage, DeliveryMessage, MessageAttachment } from "./types";

const attachmentKinds = new Set(["image", "document", "audio", "video", "archive", "code", "file"]);

export function mergeStreamDelivery(
  existing: ChatMessage[],
  delivery: DeliveryMessage,
  streamMessageId: string,
  finalized: boolean,
  clientRequestId = deliveryClientRequestId(delivery),
) {
  if (!clientRequestId) return existing;
  const deliveryAttachments = attachmentsFromDelivery(delivery);
  const deliveryContent = contentWithoutRenderedAttachmentMarkers(
    delivery.content,
    deliveryAttachments,
    delivery.metadata,
  );
  const operation = chunkOperation(delivery.metadata);
  const streaming = !finalized;
  const updateMessage = (message: ChatMessage): ChatMessage => ({
    ...message,
    id: streamMessageId,
    streamMessageId,
    clientRequestId,
    content: operation === "replace"
      ? deliveryContent
      : finalized
        ? completedContentForStream(message.content, deliveryContent)
        : appendDeltaContent(message.content, deliveryContent),
    attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
    streaming,
  });

  const clientRequestMatchIndex = existing.findIndex(
    (message) => message.role === "assistant" && message.clientRequestId === clientRequestId,
  );
  if (clientRequestMatchIndex !== -1) {
    return existing.map((message, index) => (index === clientRequestMatchIndex ? updateMessage(message) : message));
  }

  const assistantMessage: ChatMessage = {
    id: streamMessageId,
    role: "assistant",
    content: deliveryContent,
    streaming,
    streamMessageId,
    clientRequestId,
    attachments: deliveryAttachments.length ? deliveryAttachments : undefined,
  };
  return [
    ...existing,
    assistantMessage,
  ];
}

export function mergeCompletedDelivery(
  existing: ChatMessage[],
  delivery: DeliveryMessage,
  clientRequestId = deliveryClientRequestId(delivery),
) {
  if (!clientRequestId && delivery.source !== "hermes-cron") return existing;
  const deliveryAttachments = attachmentsFromDelivery(delivery);
  const deliveryContent = contentWithoutRenderedAttachmentMarkers(
    delivery.content,
    deliveryAttachments,
    delivery.metadata,
  );
  const matchIndex = clientRequestId
    ? existing.findIndex((message) => message.role === "assistant" && message.clientRequestId === clientRequestId)
    : -1;
  if (matchIndex !== -1) {
    return existing.map((message, index) =>
      index === matchIndex
        ? {
            ...message,
            id: message.streamMessageId || delivery.id,
            content: completedContentForStream(message.content, deliveryContent),
            attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
            streaming: false,
          }
        : message,
    );
  }
  const assistantMessage: ChatMessage = {
    id: delivery.id,
    role: "assistant",
    content: deliveryContent,
    clientRequestId: clientRequestId || undefined,
    streaming: false,
    source: delivery.source === "hermes-cron" ? delivery.source : undefined,
    attachments: deliveryAttachments.length ? deliveryAttachments : undefined,
  };
  return [
    ...existing,
    assistantMessage,
  ];
}

export function mergeErrorDelivery(
  existing: ChatMessage[],
  delivery: DeliveryMessage,
  clientRequestId = deliveryClientRequestId(delivery),
) {
  if (!clientRequestId) return existing;
  const errorMessage = streamErrorMessage(delivery);
  const matchIndex = existing.findIndex(
    (message) => message.role === "assistant" && message.clientRequestId === clientRequestId,
  );
  if (matchIndex === -1) {
    const errorAssistant: ChatMessage = {
      id: delivery.id,
      role: "assistant",
      content: errorMessage,
      clientRequestId,
      streaming: false,
      source: delivery.source,
    };
    return [
      ...existing,
      errorAssistant,
    ];
  }
  return existing.map((message, index) =>
    index === matchIndex
      ? {
          ...message,
          content: message.content.trim() ? `${message.content}\n\n${errorMessage}` : errorMessage,
          streaming: false,
          source: delivery.source,
        }
      : message,
  );
}

export function deliveryClientRequestId(delivery: DeliveryMessage) {
  return stringMetadata(delivery.metadata, "clientRequestId") ||
    stringMetadata(delivery.metadata, "client_request_id") ||
    stringMetadata(delivery.metadata, "replyTo") ||
    stringMetadata(delivery.metadata, "reply_to");
}

export function attachmentsFromDelivery(delivery: DeliveryMessage): MessageAttachment[] {
  return attachmentsFromMetadata(delivery.metadata);
}

export function attachmentsFromMetadata(metadata: Record<string, unknown> | undefined): MessageAttachment[] {
  if (!metadata || !Array.isArray(metadata.attachments)) return [];
  return metadata.attachments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" && candidate.id ? candidate.id : createAttachmentId();
    const name = typeof candidate.name === "string" && candidate.name ? candidate.name : "Attached file";
    const kind: AttachmentKind = typeof candidate.kind === "string" && attachmentKinds.has(candidate.kind)
      ? candidate.kind as AttachmentKind
      : "file";
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
    return [{ id, name, kind, mimeType, size, lastModified, previewUrl, downloadUrl, localPath }];
  });
}

export function mergeMessageAttachments(
  left: MessageAttachment[] | undefined,
  right: MessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
  const merged: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of [...(left || []), ...(right || [])]) {
    const key = attachment.id || attachment.downloadUrl || attachment.previewUrl || attachment.localPath || attachment.name;
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

function completedContentForStream(currentContent: string, deliveryContent: string) {
  const current = currentContent.trim();
  if (current && deliveryContent.trimStart().startsWith(current)) {
    return deliveryContent;
  }
  return appendDeltaContent(currentContent, deliveryContent);
}

function appendDeltaContent(content: string, addition: string) {
  if (!content) return addition;
  if (!addition) return content;
  return `${content}${addition}`;
}

function chunkOperation(metadata: DeliveryMessage["metadata"]) {
  const value = typeof metadata.chunkOperation === "string"
    ? metadata.chunkOperation
    : typeof metadata.chunk_operation === "string"
      ? metadata.chunk_operation
      : "";
  return value.toLowerCase() === "replace" ? "replace" : "append";
}

function streamErrorMessage(delivery: DeliveryMessage) {
  const metadataError = delivery.metadata.error;
  const detail = typeof metadataError === "string" && metadataError.trim()
    ? metadataError.trim()
    : delivery.content.trim();
  return detail ? `Assistant stream failed: ${detail}` : "Assistant stream failed.";
}

function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
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

function createAttachmentId() {
  return globalThis.crypto?.randomUUID?.() || `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
