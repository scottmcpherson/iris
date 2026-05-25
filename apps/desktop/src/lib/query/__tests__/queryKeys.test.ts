import { describe, expect, it } from "vitest";
import { defaultManagedLocalProfile } from "../../../app/runtimeConfig";
import type { HermesRuntimeConfig } from "../../../types/hermes";
import { automationsQueryOptions } from "../automations";
import { ensureOk } from "../ensureOk";
import { memoryKeys } from "../memory";
import { modelCatalogQueryOptions, modelKeys } from "../models";
import { projectKeys, projectSessionsQueryOptions } from "../projects";
import { runtimeRouteQueryKey } from "../runtimeKey";
import { sessionKeys, sessionsQueryOptions } from "../sessions";
import { skillCatalogQueryOptions, skillKeys } from "../skills";
import { slashCommandKeys, slashCommandsQueryOptions } from "../slashCommands";
import { statusKeys, statusQueryOptions } from "../status";

describe("query helpers", () => {
  it("throws failed Core envelope responses so Query records an error", async () => {
    await expect(ensureOk(Promise.resolve({ ok: false, error: "Core offline" }))).rejects.toThrow("Core offline");
    await expect(ensureOk(Promise.resolve({ ok: false }), "Fallback")).rejects.toThrow("Fallback");
    await expect(ensureOk(Promise.resolve({ ok: true, value: 1 }))).resolves.toEqual({ ok: true, value: 1 });
  });

  it("partitions cache keys by runtime route identity", () => {
    const local = runtimeConfig({
      activeConnectionId: "core_local",
      coreConnections: [defaultManagedLocalProfile],
    });
    const tailscale = runtimeConfig({
      connectionMode: "tailscale",
      activeConnectionId: "core_ts_prod",
      coreConnections: [
        {
          id: "core_ts_prod",
          name: "prod",
          mode: "tailscale",
          effectiveCoreApiUrl: "http://prod.tailnet.ts.net:8765",
          tailscale: {
            hostId: "core_ts_prod",
            hostLabel: "prod",
            magicDnsName: "prod.tailnet.ts.net",
            corePort: 8765,
          },
        },
        defaultManagedLocalProfile,
      ],
    });

    expect(runtimeRouteQueryKey(local)).not.toBe(runtimeRouteQueryKey(tailscale));
    expect(statusKeys.detail(runtimeRouteQueryKey(local), "default")).not.toEqual(
      statusKeys.detail(runtimeRouteQueryKey(tailscale), "default"),
    );
  });

  it("uses entity-owned query key namespaces", () => {
    const routeKey = "managed-local|core_local|http://127.0.0.1:8765";

    expect(memoryKeys.agent(routeKey, "default")).toEqual(["memory", routeKey, "default"]);
    expect(modelKeys.catalog(routeKey, "default")).toEqual(["models", routeKey, "catalog", "default"]);
    expect(slashCommandKeys.catalog(routeKey, "default")).toEqual([
      "slashCommands",
      routeKey,
      "catalog",
      "default",
    ]);
    expect(projectKeys.sessions(routeKey, "project_1")).toEqual([
      "projects",
      routeKey,
      "detail",
      "project_1",
      "sessions",
    ]);
    expect(sessionKeys.detail(routeKey, "session_1")).toEqual(["sessions", routeKey, "detail", "session_1"]);
    expect(skillKeys.catalog(routeKey, "default")).toEqual(["skills", routeKey, "catalog", "default"]);
  });

  it("keeps query options scoped and gated by the owning entity", () => {
    const runtime = runtimeConfig({});
    const routeKey = runtimeRouteQueryKey(runtime);

    expect(statusQueryOptions(runtime, "default").queryKey).toEqual(statusKeys.detail(routeKey, "default"));
    expect(sessionsQueryOptions(runtime, "default").queryKey).toEqual(sessionKeys.list(routeKey, "default"));
    expect(modelCatalogQueryOptions(runtime, "default", false).enabled).toBe(false);
    expect(skillCatalogQueryOptions(runtime, "default", false).enabled).toBe(false);
    expect(slashCommandsQueryOptions(runtime, "default", false).enabled).toBe(false);
    expect(automationsQueryOptions(runtime, "agent_1", true).refetchInterval).toBe(6_000);
    expect(automationsQueryOptions(runtime, "", true).enabled).toBe(false);
    expect(projectSessionsQueryOptions(runtime, "project_1").enabled).toBe(true);
    expect(projectSessionsQueryOptions(runtime, "").enabled).toBe(false);
  });
});

function runtimeConfig(overrides: Partial<HermesRuntimeConfig>): HermesRuntimeConfig {
  return {
    connectionMode: "managed-local",
    activeConnectionId: "core_local",
    coreConnections: [defaultManagedLocalProfile],
    provider: "",
    model: "",
    ...overrides,
  };
}
