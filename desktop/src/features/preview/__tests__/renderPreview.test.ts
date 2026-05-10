import { describe, expect, it } from "vitest";
import { renderPreviewDocument } from "../renderPreview";

describe("renderPreviewDocument", () => {
  it("compiles React previews before injecting them into the sandbox", () => {
    const document = renderPreviewDocument(
      "react",
      'ReactDOM.createRoot(document.getElementById("root")).render(<h1>Hello</h1>);',
      "artifact_1",
    );

    expect(document).toContain("React.createElement");
    expect(document).not.toContain("Babel.transform");
    expect(document).not.toContain("new Function");
  });
});
