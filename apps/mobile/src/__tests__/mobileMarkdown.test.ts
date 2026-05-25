import { describe, expect, it } from "vitest";
import { parseInlineMarkdown, parseMobileMarkdown } from "../chat/mobileMarkdown";

describe("mobile markdown", () => {
  it("renders prose, lists, nested list items, and inline code as structured blocks", () => {
    const blocks = parseMobileMarkdown(
      [
        "Performed a couple of test tool calls:",
        "",
        "- `date` returned: `Mon May 25 04:32:24 EDT 2026`",
        "- `pwd && printf 'ok\\n'` returned:",
        "  - Working directory: `/Users/scott`",
        "  - Status: `ok`",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { type: "paragraph", text: "Performed a couple of test tool calls:" },
      {
        type: "list",
        items: [
          {
            marker: "-",
            ordered: false,
            level: 0,
            text: "`date` returned: `Mon May 25 04:32:24 EDT 2026`",
          },
          {
            marker: "-",
            ordered: false,
            level: 0,
            text: "`pwd && printf 'ok\\n'` returned:",
          },
          {
            marker: "-",
            ordered: false,
            level: 1,
            text: "Working directory: `/Users/scott`",
          },
          {
            marker: "-",
            ordered: false,
            level: 1,
            text: "Status: `ok`",
          },
        ],
      },
    ]);
  });

  it("splits inline markdown into styled segments", () => {
    expect(parseInlineMarkdown("Run `date` then **check** [docs](https://example.com).")).toEqual([
      { type: "text", text: "Run " },
      { type: "code", text: "date" },
      { type: "text", text: " then " },
      { type: "strong", text: "check" },
      { type: "text", text: " " },
      { type: "link", text: "docs" },
      { type: "text", text: "." },
    ]);
  });
});
