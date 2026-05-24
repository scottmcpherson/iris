import { createIrisCoreClient } from "@iris/core-client";

export function createMobileCoreClient(localCoreUrl: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  return createIrisCoreClient({
    baseUrl: localCoreUrl,
    fetch: fetchImpl,
  });
}
