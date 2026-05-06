import { describe, expect, it } from "vitest";
import type { HermesSlashCommand } from "../../../types/hermes";
import {
  filterSlashCommands,
  moveSlashCommandIndex,
  slashCommandInsertion,
  slashTokenAtCursor,
} from "../slashCommands";

const commands: HermesSlashCommand[] = [
  command({ name: "resume", description: "Resume an existing session" }),
  command({ name: "reload-skills", aliases: ["reload_skills"], description: "Re-scan skills" }),
  command({ name: "reasoning", description: "Adjust reasoning effort" }),
  command({ name: "software-development", source: "skill", argsHint: "[instruction]" }),
  command({ name: "model", argsHint: "<provider/model>", requiresArgument: true }),
];

describe("slash command helpers", () => {
  it("detects a slash token at the start of the composer line", () => {
    expect(slashTokenAtCursor("/", 1)).toEqual({ from: 0, to: 1, query: "" });
    expect(slashTokenAtCursor("/re", 3)).toEqual({ from: 0, to: 3, query: "re" });
    expect(slashTokenAtCursor("hello /re", 9)).toBeNull();
    expect(slashTokenAtCursor("/reload skills", 14)).toBeNull();
  });

  it("ranks prefix matches ahead of weaker substring matches", () => {
    expect(filterSlashCommands(commands, "reload").map((item) => item.text)[0]).toBe("/reload-skills");
  });

  it("matches aliases", () => {
    expect(filterSlashCommands(commands, "reload_").map((item) => item.text)).toEqual(["/reload-skills"]);
  });

  it("adds a trailing space for skills and commands requiring arguments", () => {
    const token = slashTokenAtCursor("/soft", 5);
    expect(token).not.toBeNull();
    expect(slashCommandInsertion("/soft", token!, commands[3])).toEqual({
      value: "/software-development ",
      cursor: 22,
    });

    const modelToken = slashTokenAtCursor("/mod", 4);
    expect(slashCommandInsertion("/mod", modelToken!, commands[4])).toEqual({
      value: "/model ",
      cursor: 7,
    });
  });

  it("inserts commands without args without a trailing space", () => {
    const token = slashTokenAtCursor("/rel", 4);
    expect(slashCommandInsertion("/rel", token!, commands[1])).toEqual({
      value: "/reload-skills",
      cursor: 14,
    });
  });

  it("wraps arrow navigation predictably", () => {
    expect(moveSlashCommandIndex(0, -1, 3)).toBe(2);
    expect(moveSlashCommandIndex(2, 1, 3)).toBe(0);
    expect(moveSlashCommandIndex(-1, 1, 3)).toBe(0);
    expect(moveSlashCommandIndex(0, 1, 0)).toBe(0);
  });
});

function command(overrides: Partial<HermesSlashCommand>): HermesSlashCommand {
  const name = overrides.name || "help";
  return {
    id: `hermes:${name}`,
    name,
    text: `/${name}`,
    label: `/${name}`,
    description: "",
    category: "Commands",
    source: "hermes",
    aliases: [],
    argsHint: "",
    subcommands: [],
    requiresArgument: false,
    ...overrides,
  };
}
