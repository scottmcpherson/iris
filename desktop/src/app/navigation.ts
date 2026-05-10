import { Bot, Clock3, SquarePen } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { View } from "./types";

export const navItems: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "chat", label: "New session", icon: SquarePen },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "jobs", label: "Automations", icon: Clock3 },
];

export function viewTitle(view: View) {
  return {
    chat: "Session",
    agents: "Agents",
    jobs: "Automations",
  }[view];
}
