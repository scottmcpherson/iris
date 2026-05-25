import {
  coreEventToDeliveryMessage,
  deliveryClientRequestId,
  mergeCompletedDelivery,
  mergeErrorDelivery,
  mergeStreamDelivery,
  modelSwitchSelectionForSend,
  stringMetadata,
  streamDeliveryFinalized,
  type ChatMessage,
} from "@iris/chat-core";
import type { CoreMetadata, IrisCoreEvent, IrisCoreModelSelection } from "@iris/core-client";

export type MobileEventMergeResult = {
  messages: ChatMessage[];
  requestFinished: boolean;
  clientRequestId: string;
  deliveryId: string;
};

export type MobileChatEventInfo = {
  clientRequestId: string;
  deliveryId: string;
  requestFinished: boolean;
  streamMessageId: string;
  isError: boolean;
};

export function mergeMobileChatEvent(messages: ChatMessage[], event: IrisCoreEvent): MobileEventMergeResult {
  const info = mobileChatEventInfo(event);
  const delivery = coreEventToDeliveryMessage(event);
  if (info.isError) {
    return {
      messages: mergeErrorDelivery(messages, delivery),
      clientRequestId: info.clientRequestId,
      deliveryId: info.deliveryId,
      requestFinished: true,
    };
  }
  if (info.streamMessageId && event.type.startsWith("message.assistant")) {
    const finalized = streamDeliveryFinalized(event.metadata || {});
    return {
      messages: mergeStreamDelivery(
        messages,
        delivery,
        info.streamMessageId,
        finalized,
      ),
      clientRequestId: info.clientRequestId,
      deliveryId: info.deliveryId,
      requestFinished: finalized,
    };
  }
  if (event.type.includes("completed")) {
    return {
      messages: mergeCompletedDelivery(messages, delivery),
      clientRequestId: info.clientRequestId,
      deliveryId: info.deliveryId,
      requestFinished: true,
    };
  }
  if (event.type.includes("assistant")) {
    const finalized = streamDeliveryFinalized(event.metadata || {});
    return {
      messages: mergeStreamDelivery(
        messages,
        delivery,
        event.externalMessageId || event.id,
        finalized,
      ),
      clientRequestId: info.clientRequestId,
      deliveryId: info.deliveryId,
      requestFinished: finalized,
    };
  }
  return { messages, clientRequestId: info.clientRequestId, deliveryId: info.deliveryId, requestFinished: false };
}

export function mobileChatEventInfo(event: IrisCoreEvent): MobileChatEventInfo {
  const delivery = coreEventToDeliveryMessage(event);
  const streamMessageId = stringMetadata(delivery.metadata, "streamMessageId") ||
    stringMetadata(delivery.metadata, "stream_message_id");
  const isError = event.type === "message.error" ||
    event.type === "message.assistant.error" ||
    Boolean(delivery.metadata.error);
  return {
    clientRequestId: deliveryClientRequestId(delivery),
    deliveryId: delivery.id,
    streamMessageId,
    isError,
    requestFinished: isError ||
      (Boolean(streamMessageId) && event.type.startsWith("message.assistant")
        ? streamDeliveryFinalized(event.metadata || {})
        : event.type.includes("completed")),
  };
}

export function mobileSendMetadata({
  clientRequestId,
  source,
  projectId,
  profile,
  selectedModel,
  currentModel,
}: {
  clientRequestId: string;
  source: string;
  projectId?: string | null;
  profile?: string;
  selectedModel?: IrisCoreModelSelection | null;
  currentModel?: IrisCoreModelSelection | null;
}): CoreMetadata {
  const modelSwitch = modelSwitchSelectionForSend(selectedModel || null, currentModel || null);
  return {
    clientRequestId,
    source,
    ...(projectId ? { projectId } : {}),
    ...(profile ? { profile } : {}),
    ...(modelSwitch ? { modelSwitch: { provider: modelSwitch.provider || "", model: modelSwitch.model } } : {}),
  };
}
