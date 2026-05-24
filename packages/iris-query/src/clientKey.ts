import type { IrisCoreClient } from "@iris/core-client";

export function clientKeyFromBaseUrl(client: IrisCoreClient) {
  return client.transport.baseUrl.replace(/\/+$/, "");
}
