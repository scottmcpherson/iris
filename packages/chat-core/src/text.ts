export function compactText(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  if (maxLength <= 1) return compacted.slice(0, maxLength);
  if (maxLength <= 3) return compacted.slice(0, maxLength);
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function sessionTitleFromPrompt(prompt: string) {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const attachmentTitle = titleFromAttachmentSummary(firstLine || "");
  if (attachmentTitle) return attachmentTitle;
  return compactText(firstLine || "New session", 90);
}

const markdownBlockPattern =
  /^\s{0,3}(#{1,6}\s|[-*+]\s+|\d+[.)]\s+|>\s?|([-*_])(?:\s*\2){2,}\s*$|\[[^\]]+\]:\s|\|)/;
const tableDividerPattern = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const indentedCodePattern = /^\s{4}\S/;
const htmlBlockPattern = /^\s{0,3}<\/?[A-Za-z][^>]*>\s*$/;

export function normalizeChatMarkdown(content: string) {
  if (!content.includes("\n")) return content;

  const lines = content.split("\n");
  const output: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output.push(line);

    if (isFenceBoundary(line)) {
      inFence = !inFence;
    }

    if (index === lines.length - 1) continue;

    const nextLine = lines[index + 1];
    if (shouldPromoteLineBreakToParagraph(line, nextLine, inFence)) {
      output.push("");
    }
  }

  return output.join("\n");
}

function titleFromAttachmentSummary(firstLine: string) {
  const match = firstLine.match(/^\d+\.\s+(.+?)\s+\(([^)]*)\)/u);
  if (!match) return "";
  const name = match[1].trim();
  const detail = match[2].toLowerCase();
  if (detail.includes("audio/") || /\.(aac|flac|m4a|mp3|mp4|mpeg|mpga|ogg|wav|webm)$/iu.test(name)) {
    return "Voice message";
  }
  return compactText(name || "Attached file", 90);
}

function shouldPromoteLineBreakToParagraph(currentLine: string, nextLine: string, inFence: boolean) {
  if (inFence) return false;
  if (!currentLine.trim() || !nextLine.trim()) return false;
  if (endsWithMarkdownHardBreak(currentLine)) return false;
  if (isMarkdownBlockLine(currentLine) || isMarkdownBlockLine(nextLine)) return false;
  return true;
}

function isFenceBoundary(line: string) {
  return /^\s{0,3}(```|~~~)/.test(line);
}

function endsWithMarkdownHardBreak(line: string) {
  return /(?: {2,}|\\)$/.test(line);
}

function isMarkdownBlockLine(line: string) {
  return (
    markdownBlockPattern.test(line) ||
    tableDividerPattern.test(line) ||
    indentedCodePattern.test(line) ||
    htmlBlockPattern.test(line)
  );
}
