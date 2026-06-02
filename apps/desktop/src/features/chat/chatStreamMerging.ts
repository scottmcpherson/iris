import type { AttachmentKind, Message, MessageAttachment } from "../../app/types";
import type { HermesInboxMessage } from "../../types/hermes";
import {
  mergeStreamToolEvent,
  streamToolEventsFromMetadata,
} from "./toolEvents";
import { isAssistantThinkingPlaceholder } from "./assistantStatus";

const attachmentKinds = new Set<AttachmentKind>(["image", "document", "audio", "video", "archive", "code", "file"]);

export function mergeStreamDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  streamMessageId: string,
  finalized: boolean,
  clientRequestId = "",
) {
  if (!streamMessageId) {
    // A stream delivery is always keyed by a streamMessageId; without one there is
    // nothing to attach the snapshot to.
    console.warn("Dropped assistant stream delivery without streamMessageId.", {
      deliveryId: delivery.id,
    });
    return existing;
  }
  // An uncorrelated delivery (A1: no clientRequestId/replyTo resolvable) still
  // carries a streamMessageId, so we render the snapshot keyed by that rather than
  // dropping it — a late reply is never lost (D5).
  const deliveryAttachments = attachmentsFromDelivery(delivery);
  const content = contentWithoutRenderedAttachmentMarkers(delivery.content, deliveryAttachments, delivery.metadata);
  const liveToolEvents = streamToolEventsFromMetadata(delivery.metadata, delivery.id);
  const messageContent = liveToolEvents.length && !content.trim() ? "" : content;
  const operation = chunkOperation(delivery.metadata);
  // Core assembles the message server-side and publishes full content-so-far
  // snapshots (assembled === true / chunkOperation === "replace"). We render the
  // snapshot verbatim — no delta-stitching — so a dropped/duplicated/reordered
  // event can never corrupt the text. The append path below is kept only as a
  // fallback for an older Core that still streams incremental deltas.
  const assembled = isAssembledSnapshot(delivery.metadata, operation);
  const streaming = !finalized;
  const updateMessage = (message: Message): Message => {
    const streamEvents = streamEventsForUpdate(message, liveToolEvents, finalized);
    const replacingPlaceholder = !message.streamMessageId;
    const nextContent = assembled || replacingPlaceholder
      ? messageContent
      : finalized
        ? completedContentForStream(message.content, messageContent, operation)
        : appendDeltaContent(message.content, messageContent);
    return {
      ...message,
      id: streamMessageId,
      streamMessageId,
      ...(clientRequestId ? { clientRequestId } : {}),
      content: nextContent,
      attachments: replacingPlaceholder
        ? (deliveryAttachments.length ? deliveryAttachments : undefined)
        : mergeMessageAttachments(message.attachments, deliveryAttachments),
      streaming,
      ...(streamEvents?.length ? { streamEvents } : {}),
    };
  };
  const clientRequestMatchIndex = clientRequestId
    ? existing.findIndex(
        (message) => message.role === "assistant" && message.clientRequestId === clientRequestId,
      )
    : -1;
  if (clientRequestMatchIndex !== -1) {
    return existing.map((message, index) => (index === clientRequestMatchIndex ? updateMessage(message) : message));
  }
  const streamIndex = existing.findIndex((message) =>
    message.role === "assistant" &&
    !message.clientRequestId &&
    (message.streamMessageId === streamMessageId || message.id === streamMessageId)
  );
  if (streamIndex !== -1) {
    return existing.map((message, index) => (index === streamIndex ? updateMessage(message) : message));
  }

  const assistantMessage: Message = {
    id: streamMessageId,
    role: "assistant",
    content: messageContent,
    streaming,
    streamMessageId,
    ...(clientRequestId ? { clientRequestId } : {}),
    attachments: deliveryAttachments.length ? deliveryAttachments : undefined,
    ...(liveToolEvents.length ? { streamEvents: liveToolEvents } : {}),
  };
  return coalescePostStreamAttachments([...existing, assistantMessage]);
}

/**
 * Merge a tool-progress delivery (source "hermes-tool-progress") into the live
 * transcript. Tool activity is delivered out-of-band from the assistant text, so
 * we attach it to the in-flight assistant turn's `streamEvents` (deduped by
 * callId) rather than its `content` — which the assembled text snapshots replace
 * wholesale. The events stay `running` and are flipped to `completed` when the
 * turn's stream finalizes (`completedStreamEvents`). If the tool fires before any
 * assistant text, we seed a streaming placeholder keyed by clientRequestId so the
 * later text stream attaches to (and finalizes) the same message.
 */
export function mergeToolProgressDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  clientRequestId: string,
): Message[] {
  const toolEvents = streamToolEventsFromMetadata(delivery.metadata, delivery.id);
  if (!toolEvents.length) return existing;
  const matchIndex = clientRequestId
    ? existing.findIndex(
        (message) => message.role === "assistant" && message.clientRequestId === clientRequestId,
      )
    : -1;
  if (matchIndex !== -1) {
    return existing.map((message, index) =>
      index === matchIndex
        ? {
            ...message,
            streamEvents: toolEvents.reduce(
              (current, event) => mergeStreamToolEvent(current, event),
              message.streamEvents || [],
            ),
          }
        : message,
    );
  }
  const placeholder: Message = {
    id: delivery.id,
    role: "assistant",
    content: "",
    streaming: true,
    ...(clientRequestId ? { clientRequestId } : {}),
    streamEvents: toolEvents,
  };
  return [...existing, placeholder];
}

export function mergeCompletedDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  replyTo: string,
  clientRequestId = "",
) {
  const deliveryAttachments = attachmentsFromDelivery(delivery);
  const deliveryContent = contentWithoutRenderedAttachmentMarkers(delivery.content, deliveryAttachments, delivery.metadata);
  const cronDelivery = delivery.source === "hermes-cron";
  if (!clientRequestId && !cronDelivery) {
    console.warn("Dropped completed assistant delivery without clientRequestId.", {
      deliveryId: delivery.id,
      replyTo,
    });
    return existing;
  }
  const clientRequestMatchIndex = clientRequestId
    ? existing.findIndex(
        (message) => message.role === "assistant" && message.clientRequestId === clientRequestId,
      )
    : -1;
  if (clientRequestMatchIndex !== -1) {
    return coalescePostStreamAttachments(
      existing.map((message, index) =>
        index === clientRequestMatchIndex
            ? completedStreamingMessage(message, delivery, deliveryContent, deliveryAttachments)
            : message,
      ),
    );
  }
  const assistantMessage: Message = {
    id: delivery.id,
    role: "assistant",
    content: deliveryContent,
    ...(delivery.source === "hermes-cron" ? { source: delivery.source } : {}),
    ...(clientRequestId ? { clientRequestId } : {}),
    streaming: false,
    attachments: deliveryAttachments.length ? deliveryAttachments : undefined,
  };
  return coalescePostStreamAttachments([...existing, assistantMessage]);
}

export function mergeErrorDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  clientRequestId = "",
) {
  const errorMessage = streamErrorMessage(delivery);
  if (!clientRequestId) {
    console.warn("Dropped assistant error delivery without clientRequestId.", { deliveryId: delivery.id });
    return existing;
  }
  const matchIndex = existing.findIndex(
    (message) => message.role === "assistant" && message.clientRequestId === clientRequestId,
  );
  const errorAssistant: Message = {
    id: delivery.id,
    role: "assistant",
    content: errorMessage,
    clientRequestId,
    streaming: false,
    source: delivery.source,
  };
  if (matchIndex === -1) return [...existing, errorAssistant];
  return existing.map((message, index) =>
    index === matchIndex
      ? {
          ...message,
          id: message.streamMessageId || message.id,
          content: message.content && !isAssistantThinkingPlaceholder(message.content)
            ? `${message.content}\n\n${errorMessage}`
            : errorMessage,
          streaming: false,
          source: delivery.source,
        }
      : message,
  );
}

function completedStreamingMessage(
  message: Message,
  delivery: HermesInboxMessage,
  deliveryContent: string,
  deliveryAttachments: MessageAttachment[],
): Message {
  if (!message.streamMessageId) {
    const streamEvents = completedStreamEvents(message);
    return {
      ...message,
      id: delivery.id,
      content: deliveryContent,
      attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
      streaming: false,
      ...(streamEvents?.length ? { streamEvents } : {}),
    };
  }
  const streamEvents = completedStreamEvents(message);
  const operation = chunkOperation(delivery.metadata);
  const content = completedContentForStream(message.content, deliveryContent, operation);
  return {
    ...message,
    content,
    attachments: mergeMessageAttachments(message.attachments, deliveryAttachments),
    streaming: false,
    ...(streamEvents?.length ? { streamEvents } : {}),
  };
}

function completedContentForStream(currentContent: string, deliveryContent: string, operation: "append" | "replace") {
  if (operation === "replace") return deliveryContent;
  const current = currentContent.trim();
  if (current && deliveryContent.trimStart().startsWith(current)) {
    return deliveryContent;
  }
  return appendDeltaContent(currentContent, deliveryContent);
}

function streamEventsForUpdate(message: Message, liveToolEvents: ReturnType<typeof streamToolEventsFromMetadata>, finalized: boolean) {
  if (liveToolEvents.length) {
    return liveToolEvents.reduce(
      (current, event) => mergeStreamToolEvent(current, event),
      message.streamEvents || [],
    );
  }
  return finalized ? completedStreamEvents(message) : message.streamEvents;
}

function completedStreamEvents(message: Message) {
  if (!message.streamEvents?.length) return message.streamEvents;
  return message.streamEvents.map((event) =>
    event.status === "running" ? { ...event, status: "completed" as const } : event
  );
}

function appendDeltaContent(content: string, addition: string) {
  if (!content) return addition;
  if (!addition) return content;
  const replayContent = cumulativeReplayContent(content, addition);
  if (replayContent !== null) return replayContent;
  const overlap = streamAppendOverlap(content, addition);
  if (overlap >= 12) return `${content}${addition.slice(overlap)}`;
  return `${content}${addition}`;
}

function cumulativeReplayContent(content: string, addition: string) {
  if (addition.startsWith(content) && (addition.length > content.length || content.length >= 12)) return addition;
  const current = content.trimEnd();
  const next = addition.trimStart();
  if (current && next.startsWith(current) && (next.length > current.length || current.length >= 12)) return next;
  return null;
}

function streamAppendOverlap(content: string, addition: string) {
  const max = Math.min(content.length, addition.length);
  for (let size = max; size > 0; size -= 1) {
    if (content.endsWith(addition.slice(0, size))) return size;
  }
  return 0;
}

function chunkOperation(metadata: HermesInboxMessage["metadata"]) {
  const value = typeof metadata?.chunkOperation === "string"
    ? metadata.chunkOperation
    : typeof metadata?.chunk_operation === "string"
      ? metadata.chunk_operation
      : "";
  return value.toLowerCase() === "replace" ? "replace" : "append";
}

function isAssembledSnapshot(
  metadata: HermesInboxMessage["metadata"],
  operation: "append" | "replace",
) {
  return metadata?.assembled === true || operation === "replace";
}

function appendBlockContent(content: string, addition: string) {
  // Attachment post-processing joins adjacent generated-file text; stream chunks use appendDeltaContent/chunkOperation.
  const left = content.trimEnd();
  const right = addition.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

function streamErrorMessage(delivery: HermesInboxMessage) {
  const metadataError = delivery.metadata?.error;
  const detail = typeof metadataError === "string" && metadataError.trim()
    ? metadataError.trim()
    : delivery.content.trim();
  return detail ? `Assistant stream failed: ${detail}` : "Assistant stream failed.";
}

export function coalescePostStreamAttachments(messages: Message[]) {
  const coalesced: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const next = messages[index + 1];

    if (isPostStreamAttachmentMessage(message) && next && next.role === "assistant" && next.streamMessageId) {
      coalesced.push({
        ...next,
        content: appendBlockContent(next.content, contentWithoutRenderedAttachmentMarkers(message.content, message.attachments)),
        attachments: mergeMessageAttachments(next.attachments, message.attachments),
      });
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.streamMessageId && next && isPostStreamAttachmentMessage(next)) {
      coalesced.push({
        ...message,
        content: appendBlockContent(message.content, contentWithoutRenderedAttachmentMarkers(next.content, next.attachments)),
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
  const clientRequestId = typeof delivery.metadata?.clientRequestId === "string" ? delivery.metadata.clientRequestId : "";
  if (!clientRequestId) return false;
  return messages.some((message) => message.role === "assistant" && message.clientRequestId === clientRequestId);
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
    const clientRequestMatchIndex = message.clientRequestId
      ? merged.findIndex(
          (existing) =>
            existing.clientRequestId === message.clientRequestId && existing.role === message.role,
        )
      : -1;
    if (clientRequestMatchIndex !== -1) {
      byId.delete(merged[clientRequestMatchIndex].id);
      merged[clientRequestMatchIndex] = message;
      byId.add(message.id);
      continue;
    }
    byId.add(message.id);
    merged.push(message);
  }
  return merged;
}

/**
 * Reconcile the live transcript with Hermes history.
 *
 * LOCAL is chronologically authoritative: it is accumulated in send/delivery order
 * and includes messages that never enter Hermes history at all — slash-command
 * replies (e.g. /sethome) and cron deliveries arrive only over the event buffer. So
 * we keep local's ORDER and IDENTITY (no id-swap flicker, no reorder) and only fold
 * in history messages that local genuinely lacks. Each history message claims at
 * most one local message — by id, then clientRequestId, then role+normalized content
 * — so a history row is never duplicated against the local row it represents (this is
 * what kept repeated short messages from duplicating). Unclaimed history messages are
 * appended; on a fresh session open local is empty, so the result is pure history
 * order.
 */
export function reconcileMessages(local: Message[], history: Message[]): Message[] {
  const result = [...local];
  const claimed = new Array<boolean>(local.length).fill(false);
  const firstIndexById = new Map<string, number>();
  local.forEach((message, index) => {
    if (!firstIndexById.has(message.id)) firstIndexById.set(message.id, index);
  });

  for (const message of history) {
    const idIndex = firstIndexById.get(message.id);
    if (idIndex !== undefined && !claimed[idIndex]) {
      claimed[idIndex] = true; // local already holds this exact message
      continue;
    }
    let matchIndex = -1;
    if (message.clientRequestId) {
      matchIndex = local.findIndex(
        (candidate, index) =>
          !claimed[index] &&
          candidate.clientRequestId === message.clientRequestId &&
          candidate.role === message.role,
      );
    }
    if (matchIndex === -1) {
      const key = reconcileContentKey(message);
      matchIndex = local.findIndex(
        (candidate, index) => !claimed[index] && reconcileContentKey(candidate) === key,
      );
    }
    if (matchIndex !== -1) {
      claimed[matchIndex] = true; // local represents this history message — keep local in place
      continue;
    }
    result.push(message); // history-only (fresh load, or a message from another source)
  }
  return result;
}

function reconcileContentKey(message: Message): string {
  return `${message.role} ${normalizeReconcileContent(message.content)}`;
}

function normalizeReconcileContent(content: string): string {
  return content
    .trim()
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}
