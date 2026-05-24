import { createIrisCoreClient } from "@iris/core-client";

export function createMobileCoreClient(
  localCoreUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  bearerToken = "",
) {
  return createIrisCoreClient({
    baseUrl: localCoreUrl,
    fetch: fetchImpl,
    headers: bearerToken ? () => ({ Authorization: `Bearer ${bearerToken}` }) : undefined,
  });
}
