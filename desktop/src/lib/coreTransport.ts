import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HermesRuntimeConfig } from "../types/hermes";
import { activeCoreConnection, resolveCoreApiUrl } from "../app/runtimeConfig";

export type CoreResponse<T> = T & {
  ok: boolean;
  error?: string;
};

export type CoreMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CoreRequestOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
};

type CoreTransport = {
  request<T>(
    runtime: HermesRuntimeConfig | undefined,
    method: CoreMethod,
    path: string,
    body?: unknown,
    options?: CoreRequestOptions,
  ): Promise<CoreResponse<T>>;
};

export function coreBaseUrl(runtime?: HermesRuntimeConfig) {
  const base = resolveCoreApiUrl(runtime).replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export async function coreRequest<T>(
  runtime: HermesRuntimeConfig | undefined,
  method: CoreMethod,
  path: string,
  body?: unknown,
  options: CoreRequestOptions = {},
): Promise<CoreResponse<T>> {
  return currentCoreTransport().request(runtime, method, path, body, options);
}

export const browserCoreTransport: CoreTransport = {
  async request<T>(
    runtime: HermesRuntimeConfig | undefined,
    method: CoreMethod,
    path: string,
    body?: unknown,
    options: CoreRequestOptions = {},
  ): Promise<CoreResponse<T>> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${coreBaseUrl(runtime)}${normalizedPath}`;
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let timedOut = false;
  const timeout = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 2500)
    : null;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: controller?.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok && parsed.ok !== false) {
      return { ...(parsed as T), ok: false, error: parsed.error || `HTTP ${response.status}` };
    }
    return parsed as CoreResponse<T>;
  } catch (error) {
    if (timedOut && method !== "GET") {
      return { ok: false, error: "timed out" } as CoreResponse<T>;
    }
    return {
      ok: false,
      error: timedOut ? "timed out" : error instanceof Error ? error.message : "Core request failed.",
    } as CoreResponse<T>;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  },
};

export const tauriCoreTransport: CoreTransport = {
  async request<T>(
    runtime: HermesRuntimeConfig | undefined,
    method: CoreMethod,
    path: string,
    body?: unknown,
    options: CoreRequestOptions = {},
  ) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return invoke<CoreResponse<T>>("core_bridge", {
      action: "core_request",
      payload: {
        method,
        path: normalizedPath,
        body,
        runtime,
        connectionId: activeCoreConnection(runtime)?.id,
        timeoutMs: options.timeoutMs,
        idempotencyKey: options.idempotencyKey,
      },
    });
  },
};

export function coreAttachmentUrl(runtime: HermesRuntimeConfig | undefined, path: string | undefined) {
  if (!path) return "";
  if (/^(https?|blob|data|asset):/i.test(path)) return path;
  const base = coreBaseUrl(runtime);
  if (path.startsWith("/v1/")) return `${base.replace(/\/v1$/, "")}${path}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function currentCoreTransport() {
  return isTauri() ? tauriCoreTransport : browserCoreTransport;
}
