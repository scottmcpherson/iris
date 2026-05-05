import { Bot, SquarePen } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { View } from "./types";

export const navItems: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "chat", label: "New chat", icon: SquarePen },
  { id: "agents", label: "Agents", icon: Bot },
];

export function viewTitle(view: View) {
  return {
    chat: "Chat",
    agents: "Agents",
  }[view];
}
