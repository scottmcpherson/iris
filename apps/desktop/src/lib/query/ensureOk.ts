export async function ensureOk<T extends { ok?: boolean; error?: string | null }>(
  promise: Promise<T>,
  fallback = "Request failed.",
) {
  const result = await promise;
  if (result.ok === false) throw new Error(result.error || fallback);
  return result;
}
