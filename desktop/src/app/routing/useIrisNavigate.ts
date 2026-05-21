import { useRouter } from "@tanstack/react-router";
import type { AgentDetailSection } from "../../features/agents/types";
import {
  routeIntentToPath,
  type IrisRouteIntent,
} from "./routeIntent";

type NavigateOptions = {
  replace?: boolean;
};

export function useIrisNavigate() {
  const router = useRouter();

  function openIntent(intent: IrisRouteIntent, options: NavigateOptions = {}) {
    const target = routeIntentToPath(intent);
    void router.navigate({
      to: target.to,
      search: target.search as never,
      replace: options.replace,
    });
  }

  return {
    openNewChat(options: { profile?: string; projectId?: string } = {}, navOptions?: NavigateOptions) {
      openIntent({ type: "new-chat", ...options }, navOptions);
    },
    openChat(
      options: { sessionId: string; profile?: string; projectId?: string },
      navOptions?: NavigateOptions,
    ) {
      openIntent({ type: "chat", ...options }, navOptions);
    },
    openAgent(
      options: { profile?: string; section?: AgentDetailSection } = {},
      navOptions?: NavigateOptions,
    ) {
      openIntent({ type: "agents", ...options }, navOptions);
    },
    openAutomations(options: { projectId?: string } = {}, navOptions?: NavigateOptions) {
      openIntent({ type: "automations", ...options }, navOptions);
    },
    openSettings(navOptions?: NavigateOptions) {
      openIntent({ type: "settings" }, navOptions);
    },
    openIntent,
  };
}
