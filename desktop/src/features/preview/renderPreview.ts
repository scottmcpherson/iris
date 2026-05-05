import type { PreviewMode } from "../../app/types";
import babelRuntime from "virtual:preview-runtime/babel";
import mermaidRuntime from "virtual:preview-runtime/mermaid";
import reactDomRuntime from "virtual:preview-runtime/react-dom";
import reactRuntime from "virtual:preview-runtime/react";

export function renderPreviewDocument(mode: PreviewMode, source: string, artifactId: string) {
  if (mode === "react") {
    return renderReactPreviewDocument(source, artifactId);
  }
  if (mode === "markdown") {
    return htmlDocument(
      `<main class="markdown">${markdownToHtml(source)}</main>`,
      artifactId,
      `${previewBaseCss}${markdownCss}`,
    );
  }
  if (mode === "diagram") {
    return renderMermaidPreviewDocument(source, artifactId);
  }
  return renderHtmlPreviewDocument(source, artifactId);
}

function renderHtmlPreviewDocument(source: string, artifactId: string) {
  const bridge = previewBridgeScript(artifactId, true);
  if (/<!doctype html|<html[\s>]/i.test(source)) {
    if (source.includes("</body>")) return source.replace("</body>", `${bridge}</body>`);
    return `${source}${bridge}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8" /></head><body>${source}${bridge}</body></html>`;
}

function renderReactPreviewDocument(source: string, artifactId: string) {
  return htmlDocument(
    `<div id="root"></div>
    <script>${escapeScript(reactRuntime)}</script>
    <script>${escapeScript(reactDomRuntime)}</script>
    <script>${escapeScript(babelRuntime)}</script>
    <script>
      ${runtimeErrorBridge(artifactId)}
      const source = ${safeJson(source)};
      try {
        const compiled = Babel.transform(source, {
          filename: "HermesPreview.jsx",
          presets: [["react", { runtime: "classic" }]],
        }).code;
        const execute = new Function("React", "ReactDOM", compiled + "\\n//# sourceURL=HermesPreview.jsx");
        execute(window.React, window.ReactDOM);
        window.__hermesPreviewReady();
      } catch (error) {
        window.__hermesPreviewError(error);
      }
    </script>`,
    artifactId,
    `${previewBaseCss}${reactCss}`,
    false,
  );
}

function renderMermaidPreviewDocument(source: string, artifactId: string) {
  return htmlDocument(
    `<main class="diagram"><div id="diagram-root"></div></main>
    <script>${escapeScript(mermaidRuntime)}</script>
    <script>
      ${runtimeErrorBridge(artifactId)}
      const source = ${safeJson(source)};
      (async () => {
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "dark",
            fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif",
          });
          const result = await mermaid.render("hermes-mermaid-diagram", source);
          document.getElementById("diagram-root").innerHTML = result.svg;
          window.__hermesPreviewReady();
        } catch (error) {
          window.__hermesPreviewError(error);
        }
      })();
    </script>`,
    artifactId,
    `${previewBaseCss}${diagramCss}`,
    false,
  );
}

function htmlDocument(body: string, artifactId: string, css = previewBaseCss, includeReady = true) {
  return `<!doctype html><html><head><meta charset="utf-8" /><style>${css}</style></head><body>${body}${previewBridgeScript(
    artifactId,
    includeReady,
  )}</body></html>`;
}

function previewBridgeScript(artifactId: string, ready: boolean) {
  return `<script>${runtimeErrorBridge(artifactId)}${ready ? "window.__hermesPreviewReady();" : ""}</script>`;
}

function runtimeErrorBridge(artifactId: string) {
  return `
    window.__hermesPreviewReady = () => parent.postMessage({ source: "hermes-preview", artifactId: ${safeJson(
      artifactId,
    )}, type: "ready" }, "*");
    window.__hermesPreviewError = (error) => parent.postMessage({
      source: "hermes-preview",
      artifactId: ${safeJson(artifactId)},
      type: "error",
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack) : "",
    }, "*");
    window.addEventListener("error", (event) => window.__hermesPreviewError(event.error || event.message));
    window.addEventListener("unhandledrejection", (event) => window.__hermesPreviewError(event.reason));
  `;
}

function markdownToHtml(markdown: string) {
  const lines = escapeHtml(markdown).split("\n");
  const html: string[] = [];
  let listOpen = false;
  let codeOpen = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.join("<br />")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      html.push(codeOpen ? "</code></pre>" : "<pre><code>");
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) {
      html.push(`${line}\n`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      html.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      continue;
    }
    const listItem = line.match(/^-\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${listItem[1]}</li>`);
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  if (codeOpen) html.push("</code></pre>");
  return html.join("");
}

function safeJson(value: string) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScript(value: string) {
  return value.replace(/<\/script/gi, "<\\/script");
}

const previewBaseCss = `
  :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
  body { margin: 0; min-height: 100vh; background: #08090c; color: #f3f0e8; }
  button { border: 0; border-radius: 999px; padding: 12px 18px; color: #111318; background: #f4f0e7; font-weight: 700; }
  button:hover { transform: translateY(-1px); }
`;

const reactCss = `
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 32px; box-sizing: border-box; background: linear-gradient(145deg, #101824, #08090c 58%, #17120b); }
  .panel { width: min(680px, 100%); padding: 42px; border: 1px solid rgba(255,255,255,.11); border-radius: 28px; background: rgba(19,22,29,.88); box-shadow: 0 28px 80px rgba(0,0,0,.42); }
  .eyebrow { margin: 0 0 16px; color: #89d8ff; font-size: 12px; text-transform: uppercase; letter-spacing: .1em; }
  h1 { margin: 0; font-size: 56px; line-height: .98; letter-spacing: 0; }
  .meter { height: 10px; overflow: hidden; margin: 28px 0; border-radius: 999px; background: rgba(255,255,255,.1); }
  .meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #8ed7ff, #f6d88b); transition: width .35s ease; }
`;

const markdownCss = `
  .markdown { max-width: 780px; margin: 0 auto; padding: 56px 40px; line-height: 1.7; color: #d7d3ca; }
  .markdown h1 { margin: 0 0 18px; color: #fff9ef; font-size: 52px; line-height: 1; }
  .markdown h2 { margin-top: 34px; color: #fff9ef; }
  .markdown h3 { margin-top: 26px; color: #fff9ef; }
  .markdown li { margin: 8px 0; }
  .markdown pre { overflow: auto; padding: 18px; border-radius: 16px; background: #11141b; border: 1px solid rgba(255,255,255,.1); }
`;

const diagramCss = `
  .diagram { min-height: 100vh; display: grid; place-items: center; padding: 28px; box-sizing: border-box; background: #08090c; }
  #diagram-root { width: min(820px, 100%); }
  #diagram-root svg { width: 100%; height: auto; }
`;
