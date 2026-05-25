export type ChatSlashCommand = {
  id: string;
  name: string;
  text: string;
  label: string;
  description: string;
  category: string;
  source: string;
  aliases: string[];
  argsHint: string;
  subcommands: string[];
  requiresArgument: boolean;
};

export type SlashToken = {
  from: number;
  to: number;
  query: string;
};

export function slashTokenAtCursor(value: string, cursor: number): SlashToken | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, safeCursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const token = before.slice(lineStart);
  if (!token.startsWith("/")) return null;
  if (/\s/u.test(token)) return null;
  return { from: lineStart, to: safeCursor, query: token.slice(1) };
}

export function filterSlashCommands<T extends ChatSlashCommand>(commands: T[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  return commands
    .map((command) => ({
      command,
      score: scoreSlashCommand(command, needle),
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.command.text.localeCompare(right.command.text))
    .slice(0, 30)
    .map((row) => row.command);
}

export function scoreSlashCommand(command: ChatSlashCommand, needle: string) {
  const name = command.name.toLowerCase();
  const text = command.text.toLowerCase();
  const aliases = command.aliases.map((alias) => alias.toLowerCase());
  const haystack = [
    command.description,
    command.category,
    command.source,
    ...command.subcommands,
  ].join(" ").toLowerCase();

  if (name === needle || text === `/${needle}`) return 1000;
  if (name.startsWith(needle)) return 900 - name.length;
  if (text.startsWith(`/${needle}`)) return 850 - text.length;
  if (aliases.some((alias) => alias === needle)) return 820;
  if (aliases.some((alias) => alias.startsWith(needle))) return 760;
  if (name.includes(needle)) return 560 - name.indexOf(needle);
  if (aliases.some((alias) => alias.includes(needle))) return 500;
  if (haystack.includes(needle)) return 120;
  return 0;
}

export function slashCommandInsertion(
  input: string,
  token: SlashToken,
  command: ChatSlashCommand,
) {
  const suffix = command.requiresArgument || command.source === "skill" ? " " : "";
  const insertedText = command.text + suffix;
  const value = input.slice(0, token.from) + insertedText + input.slice(token.to);
  return {
    value,
    cursor: token.from + insertedText.length,
  };
}

export function slashCommandTokenIsPartial(input: string, token: SlashToken, command: ChatSlashCommand) {
  return input.slice(token.from, token.to) !== command.text;
}

export function moveSlashCommandIndex(current: number, direction: 1 | -1, total: number) {
  if (total <= 0) return 0;
  if (current < 0 || current >= total) return direction > 0 ? 0 : total - 1;
  return (current + direction + total) % total;
}
