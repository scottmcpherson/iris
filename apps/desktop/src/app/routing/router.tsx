import App from "../../App";
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { createIrisHistory } from "./history";

const rootRoute = createRootRoute({
  component: App,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat/new", replace: true });
  },
});

const chatNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/new",
});

const chatSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$sessionId",
});

const projectChatNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/chat/new",
});

const projectChatSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/chat/$sessionId",
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$profile",
});

const agentDetailSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$profile/$section",
});

const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations",
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatNewRoute,
  chatSessionRoute,
  projectChatNewRoute,
  projectChatSessionRoute,
  agentsRoute,
  agentDetailRoute,
  agentDetailSectionRoute,
  automationsRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createIrisHistory(),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
