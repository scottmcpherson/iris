import type { CoreResponse } from "@iris/core-client";

export async function ensureOk<T>(request: Promise<CoreResponse<T>>, message: string): Promise<T> {
  const result = await request;
  if (!result.ok) {
    throw new Error(result.error || message);
  }
  return result;
}
