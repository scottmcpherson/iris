import { coreBaseUrl } from "./transport";
import type {
  CoreResponse,
  IrisCoreAttachment,
  IrisCoreClient,
  UploadAttachmentPayload,
  UploadAttachmentResponse,
} from "./types";

export async function uploadAttachment(
  client: IrisCoreClient,
  payload: UploadAttachmentPayload,
): Promise<CoreResponse<UploadAttachmentResponse>> {
  const form = new FormData();
  appendFormFile(form, "file", payload.file, payload.name);
  form.append("profile", payload.profile);
  form.append("runtimeId", payload.runtimeId || "runtime_local_hermes");
  if (payload.mimeType) form.append("mimeType", payload.mimeType);
  if (payload.kind) form.append("kind", payload.kind);
  if (payload.sessionId) form.append("sessionId", payload.sessionId);
  if (payload.messageId) form.append("messageId", payload.messageId);
  if (payload.metadata) form.append("metadata", JSON.stringify(payload.metadata));

  try {
    const headers = new Headers(await client.transport.headers?.());
    headers.set("Accept", "application/json");
    headers.delete("Content-Type");
    const response = await client.transport.fetch(`${coreBaseUrl(client)}/attachments`, {
      method: "POST",
      headers,
      body: form as unknown as BodyInit,
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok && (parsed as { ok?: boolean }).ok !== false) {
      return {
        ...(parsed as UploadAttachmentResponse),
        ok: false,
        error: (parsed as { error?: string }).error || `HTTP ${response.status}`,
      };
    }
    return normalizeAttachmentUploadResponse(client, parsed as CoreResponse<UploadAttachmentResponse>);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Attachment upload failed.",
    } as CoreResponse<UploadAttachmentResponse>;
  }
}

export function coreAttachmentUrl(client: IrisCoreClient, path: string | undefined) {
  if (!path) return "";
  if (/^(https?|blob|data|asset|file):/i.test(path)) return path;
  const base = coreBaseUrl(client);
  if (path.startsWith("/v1/")) return `${base.replace(/\/v1$/, "")}${path}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function normalizeAttachmentUploadResponse(
  client: IrisCoreClient,
  result: CoreResponse<UploadAttachmentResponse>,
): CoreResponse<UploadAttachmentResponse> {
  if (!result.ok || !result.attachment) return result;
  return {
    ...result,
    attachment: normalizeCoreAttachment(client, result.attachment),
  };
}

function normalizeCoreAttachment(client: IrisCoreClient, attachment: IrisCoreAttachment): IrisCoreAttachment {
  return {
    ...attachment,
    previewUrl: coreAttachmentUrl(client, attachment.previewUrl),
    downloadUrl: coreAttachmentUrl(client, attachment.downloadUrl),
  };
}

function appendFormFile(form: FormData, name: string, file: UploadAttachmentPayload["file"], filename: string) {
  const append = form.append.bind(form) as (field: string, value: unknown, fileName?: string) => void;
  if (isReactNativeFile(file)) {
    append(name, {
      uri: file.uri,
      name: file.name || filename,
      type: file.type || "application/octet-stream",
    });
    return;
  }
  append(name, file, filename);
}

function isReactNativeFile(file: UploadAttachmentPayload["file"]): file is Exclude<UploadAttachmentPayload["file"], Blob> {
  return Boolean(
    file &&
      typeof file === "object" &&
      "uri" in file &&
      typeof file.uri === "string" &&
      file.uri,
  );
}
