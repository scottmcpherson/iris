import { runtimeDataRouteKey } from "../../app/runtimeConfig";
import type { HermesRuntimeConfig } from "../../types/hermes";

export function runtimeRouteQueryKey(runtime: HermesRuntimeConfig | undefined) {
  return runtimeDataRouteKey(runtime);
}
