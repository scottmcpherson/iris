import type { View } from "../types";
import type { AgentDetailSection } from "../../features/agents/types";

export type IrisRouteIntent =
  | { type: "new-chat"; profile?: string; projectId?: string }
  | { type: "chat"; sessionId: string; profile?: string; projectId?: string }
  | { type: "agents"; profile?: string; section?: AgentDetailSection }
  | { type: "automations"; projectId?: string }
  | { type: "settings" };

export type IrisRouteTarget = {
  to: string;
  search?: Record<string, string | undefined>;
};

const IRIS_APP_HOST = "iris.app";

export function isAgentDetailSection(value: string): value is AgentDetailSection {
  return value === "overview" || value === "memory" || value === "skills";
}

export function viewForRouteIntent(intent: IrisRouteIntent): View {
  if (intent.type === "agents") return "agents";
  if (intent.type === "automations") return "jobs";
  if (intent.type === "settings") return "settings";
  return "chat";
}

export function routeIntentToPath(intent: IrisRouteIntent): IrisRouteTarget {
  if (intent.type === "new-chat") {
    return {
      to: intent.projectId
        ? `/projects/${encodeSegment(intent.projectId)}/chat/new`
        : "/chat/new",
      search: profileSearch(intent.profile),
    };
  }
  if (intent.type === "chat") {
    return {
      to: intent.projectId
        ? `/projects/${encodeSegment(intent.projectId)}/chat/${encodeSegment(intent.sessionId)}`
        : `/chat/${encodeSegment(intent.sessionId)}`,
      search: profileSearch(intent.profile),
    };
  }
  if (intent.type === "agents") {
    if (!intent.profile) return { to: "/agents" };
    const section = intent.section && intent.section !== "overview" ? `/${intent.section}` : "";
    return { to: `/agents/${encodeSegment(intent.profile)}${section}` };
  }
  if (intent.type === "automations") {
    return {
      to: "/automations",
      search: intent.projectId ? { project: intent.projectId } : undefined,
    };
  }
  return { to: "/settings" };
}

export function routeIntentToUrl(intent: IrisRouteIntent) {
  const target = routeIntentToPath(intent);
  const search = stringifySearch(target.search);
  return `${target.to}${search}`;
}

export function routePathToIntent(
  pathname: string,
  search?: URLSearchParams | Record<string, unknown>,
): IrisRouteIntent | null {
  const segments = pathSegments(pathname);
  const profile = optionalSearchValue(search, "profile");
  if (segments.length === 0) {
    return { type: "new-chat", profile };
  }
  if (segments[0] === "chat") {
    if (segments[1] === "new" && segments.length === 2) {
      return { type: "new-chat", profile };
    }
    if (segments.length === 2 && safeRouteToken(segments[1])) {
      return { type: "chat", sessionId: segments[1], profile };
    }
    return null;
  }
  if (segments[0] === "projects") {
    const projectId = segments[1];
    if (!safeRouteToken(projectId) || segments[2] !== "chat") return null;
    if (segments[3] === "new" && segments.length === 4) {
      return { type: "new-chat", projectId, profile };
    }
    if (segments.length === 4 && safeRouteToken(segments[3])) {
      return { type: "chat", projectId, sessionId: segments[3], profile };
    }
    return null;
  }
  if (segments[0] === "agents") {
    if (segments.length === 1) return { type: "agents" };
    if (segments.length === 2 && safeRouteToken(segments[1])) {
      return { type: "agents", profile: segments[1], section: "overview" };
    }
    if (segments.length === 3 && safeRouteToken(segments[1])) {
      return isAgentDetailSection(segments[2])
        ? { type: "agents", profile: segments[1], section: segments[2] }
        : { type: "agents", profile: segments[1], section: "overview" };
    }
    return null;
  }
  if (segments[0] === "automations" && segments.length === 1) {
    return { type: "automations", projectId: optionalSearchValue(search, "project") };
  }
  if (segments[0] === "settings" && segments.length === 1) {
    return { type: "settings" };
  }
  return null;
}

export function parseIrisDeepLink(rawUrl: string): IrisRouteIntent | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol === "iris:") {
    const pathname = `/${[url.hostname, url.pathname].filter(Boolean).join("/")}`;
    return routePathToIntent(pathname, url.searchParams);
  }

  if (url.protocol === "https:" && url.hostname === IRIS_APP_HOST) {
    const segments = pathSegments(url.pathname);
    if (segments[0] !== "open") return null;
    return routePathToIntent(`/${segments.slice(1).map(encodeURIComponent).join("/")}`, url.searchParams);
  }

  return null;
}

export function sameRouteIntent(left: IrisRouteIntent | null, right: IrisRouteIntent | null) {
  return JSON.stringify(normalizeIntent(left)) === JSON.stringify(normalizeIntent(right));
}

function normalizeIntent(intent: IrisRouteIntent | null) {
  if (!intent) return null;
  if (intent.type === "agents" && intent.profile && !intent.section) {
    return { ...intent, section: "overview" };
  }
  return intent;
}

function profileSearch(profile?: string) {
  return profile ? { profile } : undefined;
}

function stringifySearch(search?: Record<string, string | undefined>) {
  if (!search) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function optionalSearchValue(search: URLSearchParams | Record<string, unknown> | undefined, key: string) {
  if (!search) return undefined;
  const value = search instanceof URLSearchParams ? search.get(key) : search[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pathSegments(pathname: string) {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => safeDecode(segment))
    .filter((segment): segment is string => Boolean(segment));
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function safeRouteToken(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !value.includes("/") && !value.includes("\\"));
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}
