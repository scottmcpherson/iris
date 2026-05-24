import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { runtimeRouteQueryKey, skillKeys } from "../../../lib/query";
import type {
  HermesRuntimeConfig,
  HermesSkill,
  HermesSkillCatalog,
  HermesSkills,
} from "../../../types/hermes";
import { SkillsView } from "../SkillsView";

describe("SkillsView", () => {
  it("renders installed skills from the selected profile query", () => {
    const html = renderSkillsView({
      profile: "health",
      skills: {
        ok: true,
        profile: "health",
        path: "/tmp/.hermes/profiles/health/skills",
        skills: [skillFixture({ name: "Health Intake", category: "clinical" })],
      },
      catalog: emptyCatalog("health"),
    });

    expect(html).toContain("clinical");
    expect(html).not.toContain("Skill authoring");
  });

  it("renders Core-backed available skills without hardcoded community inventory", () => {
    const html = renderSkillsView({
      profile: "health",
      skills: emptySkills("health"),
      catalog: {
        ok: true,
        profile: "health",
        installed: [],
        available: [{
          ...skillFixture({ name: "Default Research", category: "research" }),
          catalogId: "agent_default:c2tpbGwvU0tJTEwubWQ",
          installed: false,
          sourceProfile: "default",
          sourceAgentId: "agent_default",
          sourceSkillId: "c2tpbGwvU0tJTEwubWQ",
          targetProfile: "health",
          conflict: false,
        }],
        generatedAt: 1_774_199_763,
      },
    });

    expect(html).toContain("Available from default");
    expect(html).not.toContain("Research brief");
    expect(html).not.toContain("PRD builder");
  });

  it("shows a real empty state for a profile with no skills", () => {
    const html = renderSkillsView({
      profile: "health",
      skills: emptySkills("health"),
      catalog: emptyCatalog("health"),
    });

    expect(html).toContain("No skills installed for health.");
  });
});

function renderSkillsView({
  profile,
  skills,
  catalog,
}: {
  profile: string;
  skills: HermesSkills;
  catalog: HermesSkillCatalog;
}) {
  const runtime = runtimeConfigFixture();
  const routeKey = runtimeRouteQueryKey(runtime);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  queryClient.setQueryData(skillKeys.list(routeKey, profile), skills);
  queryClient.setQueryData(skillKeys.catalog(routeKey, profile), catalog);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SkillsView, {
        profile,
        runtimeConfig: runtime,
        connected: true,
        onProfileSkillsChanged: () => {},
      }),
    ),
  );
}

function runtimeConfigFixture(): HermesRuntimeConfig {
  return {
    connectionMode: "managed-local",
    activeConnectionId: "core_local",
    coreConnections: [{
      id: "core_local",
      name: "Local",
      mode: "managed-local",
      effectiveCoreApiUrl: "http://127.0.0.1:8765",
      local: {
        port: 8765,
        autoStart: true,
        installLaunchAgent: false,
      },
    }],
    provider: "",
    model: "",
  };
}

function skillFixture(overrides: Partial<HermesSkill> = {}): HermesSkill {
  return {
    id: "c2tpbGwvU0tJTEwubWQ",
    name: "Test Skill",
    path: "/tmp/.hermes/skills/test/SKILL.md",
    category: "personal",
    description: "Local test skill",
    updatedAt: null,
    source: "installed",
    version: null,
    tags: [],
    bytes: 12,
    metadata: {},
    ...overrides,
  };
}

function emptySkills(profile: string): HermesSkills {
  return {
    ok: true,
    profile,
    path: "",
    skills: [],
  };
}

function emptyCatalog(profile: string): HermesSkillCatalog {
  return {
    ok: true,
    profile,
    installed: [],
    available: [],
    generatedAt: 1_774_199_763,
  };
}
