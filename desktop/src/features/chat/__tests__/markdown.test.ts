import { describe, expect, it } from "vitest";
import { normalizeChatMarkdown } from "../markdown";

describe("normalizeChatMarkdown", () => {
  it("promotes single-newline prose into markdown paragraphs", () => {
    expect(normalizeChatMarkdown("First paragraph.\nSecond paragraph.\nThird paragraph.")).toBe(
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    );
  });

  it("leaves existing paragraph breaks alone", () => {
    expect(normalizeChatMarkdown("First paragraph.\n\nSecond paragraph.")).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("does not split markdown lists, tables, blockquotes, headings, or fenced code", () => {
    const markdown = [
      "# Heading",
      "Intro line.",
      "- First item",
      "- Second item",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "> Quoted",
      "> Continued",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
    ].join("\n");

    expect(normalizeChatMarkdown(markdown)).toBe(markdown);
  });
});
