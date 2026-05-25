import { normalizeChatMarkdown } from "@iris/chat-core";

export type MobileMarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "blockquote"; text: string }
  | { type: "code"; text: string }
  | { type: "list"; items: MobileMarkdownListItem[] };

export type MobileMarkdownListItem = {
  marker: string;
  ordered: boolean;
  level: number;
  text: string;
};

export type MobileMarkdownInlineSegment =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "link"; text: string };

export function parseMobileMarkdown(content: string): MobileMarkdownBlock[] {
  const normalized = normalizeChatMarkdown(content).replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const blocks: MobileMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s{0,3}(```|~~~)/u);
    if (fence) {
      const fenceMarker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${escapeRegExp(fenceMarker)}`, "u").test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/u);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (isListLine(line)) {
      const items: MobileMarkdownListItem[] = [];
      while (index < lines.length) {
        const listItem = parseListLine(lines[index]);
        if (!listItem) break;
        items.push(listItem);
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (/^\s{0,3}>\s?/u.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/u.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/u, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n").trim() });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

export function parseInlineMarkdown(content: string): MobileMarkdownInlineSegment[] {
  const segments: MobileMarkdownInlineSegment[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)]+\))/gu;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content))) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: content.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      segments.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      segments.push({ type: "strong", text: token.slice(2, -2) });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      segments.push({ type: "link", text: link?.[1] || token });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < content.length) {
    segments.push({ type: "text", text: content.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: "text", text: content }];
}

function startsBlock(line: string) {
  return (
    /^\s{0,3}(```|~~~)/u.test(line) ||
    /^\s{0,3}#{1,6}\s+/u.test(line) ||
    /^\s{0,3}>\s?/u.test(line) ||
    isListLine(line)
  );
}

function isListLine(line: string) {
  return parseListLine(line) !== null;
}

function parseListLine(line: string): MobileMarkdownListItem | null {
  const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/u);
  if (!match) return null;
  const rawMarker = match[2];
  const ordered = /^\d/u.test(rawMarker);
  return {
    marker: ordered ? rawMarker.replace(/[.)]$/u, "") : rawMarker,
    ordered,
    level: Math.min(4, Math.floor(match[1].replace(/\t/gu, "  ").length / 2)),
    text: match[3].trim(),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
