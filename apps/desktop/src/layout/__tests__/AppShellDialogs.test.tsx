import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionActionDialog } from "../AppShellDialogs";
import type { HermesSession } from "../../types/hermes";

vi.mock("radix-ui", async () => {
  const React = await import("react");
  const primitive = (name: string) =>
    React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(function Primitive(
      { children, ...props },
      ref,
    ) {
      return React.createElement("div", { ...props, ref, "data-radix-primitive": name }, children);
    });

  return {
    Dialog: {
      Root: primitive("root"),
      Trigger: primitive("trigger"),
      Portal: primitive("portal"),
      Overlay: primitive("overlay"),
      Content: primitive("content"),
      Close: primitive("close"),
      Title: primitive("title"),
      Description: primitive("description"),
    },
  };
});

describe("SessionActionDialog", () => {
  it("uses the primary button variant for the rename submit action", () => {
    const html = renderToStaticMarkup(
      createElement(SessionActionDialog, {
        dialog: {
          profileName: "default",
          session: sessionFixture(),
          name: "Follow-up notes",
        },
        busy: false,
        error: "",
        onCancel: noop,
        onChange: noop,
        onSubmit: noop,
      }),
    );

    expect(html).toMatch(
      /<button(?=[^>]*data-variant="default")(?=[^>]*type="submit")[^>]*>Rename<\/button>/,
    );
  });
});

function noop() {}

function sessionFixture(): HermesSession {
  return {
    id: "session_rename",
    source: "hermes-management",
    model: "gpt-5.5",
    title: "Follow-up notes",
    preview: "",
    startedAt: null,
    endedAt: null,
    lastActiveAt: null,
    messageCount: 0,
  };
}
