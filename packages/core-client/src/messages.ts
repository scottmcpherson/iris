import { coreRequest } from "./transport";
import type {
  IrisCoreClient,
  IrisCoreSendMessageResult,
  SendMessagePayload,
} from "./types";

export function sendMessage(client: IrisCoreClient, sessionId: string, payload: SendMessagePayload) {
  return coreRequest<IrisCoreSendMessageResult>(
    client,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
    payload,
    { idempotencyKey: payload.clientMessageId, timeoutMs: 12_000 },
  );
}
