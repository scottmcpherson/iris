import type {
  CoreMethod,
  CoreRequestOptions,
  CoreResponse,
  IrisCoreClient,
  IrisCoreTransport,
} from "./types";

export function createIrisCoreClient(transport: IrisCoreTransport): IrisCoreClient {
  return { transport };
}

export function coreBaseUrl(client: IrisCoreClient) {
  const base = client.transport.baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export async function coreRequest<T>(
  client: IrisCoreClient,
  method: CoreMethod,
  path: string,
  body?: unknown,
  options: CoreRequestOptions = {},
): Promise<CoreResponse<T>> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${coreBaseUrl(client)}${normalizedPath}`;
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let timedOut = false;
  const timeout = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 5000)
    : null;

  try {
    const extraHeaders = await client.transport.headers?.();
    const response = await client.transport.fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(extraHeaders || {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: controller?.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok && (parsed as { ok?: boolean }).ok !== false) {
      return {
        ...(parsed as T),
        ok: false,
        error: (parsed as { error?: string }).error || `HTTP ${response.status}`,
      };
    }
    return parsed as CoreResponse<T>;
  } catch (error) {
    return {
      ok: false,
      error: timedOut ? "timed out" : error instanceof Error ? error.message : "Core request failed.",
    } as CoreResponse<T>;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
