import type { PreviewMode } from "../../app/types";

export const sampleHtml = `<main class="scene">
  <section>
    <span>Hermes artifact</span>
    <h1>Persistent agents deserve a living workspace.</h1>
    <p>This preview is sandboxed and refreshes as you type.</p>
    <button onclick="document.body.classList.toggle('warm')">Shift tone</button>
  </section>
</main>
<style>
  :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090a0d; color: #f7f4ee; }
  body.warm { background: #14100c; }
  .scene { width: min(720px, calc(100vw - 40px)); min-height: 420px; display: grid; align-items: end; padding: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 28px; background: linear-gradient(145deg, #171b23, #0c0d11 62%, #18120d); box-shadow: 0 30px 90px rgba(0,0,0,.45); }
  span { color: #8fd6ff; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
  h1 { max-width: 560px; margin: 14px 0; font-size: 64px; line-height: .98; letter-spacing: 0; }
  p { max-width: 440px; color: #bbb7ae; font-size: 18px; line-height: 1.55; }
  button { margin-top: 20px; border: 0; border-radius: 999px; padding: 12px 18px; color: #101114; background: #f4f0e7; font-weight: 700; }
</style>`;

const sampleReact = `function HermesPreview() {
  const [level, setLevel] = React.useState(72);
  return (
    <main className="wrap">
      <section className="panel">
        <p className="eyebrow">Live React preview</p>
        <h1>Memory growth is visible, editable, and alive.</h1>
        <div className="meter"><span style={{ width: level + "%" }} /></div>
        <button onClick={() => setLevel((level + 11) % 100)}>Simulate learning</button>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<HermesPreview />);`;

const sampleMarkdown = `# Skill Draft

Hermes should turn repeated success into reusable procedural memory.

## Scope

- Capture user intent
- Preserve command evidence
- Store the reusable workflow

\`\`\`ts
type Skill = {
  name: string;
  trigger: string;
  instructions: string;
}
\`\`\``;

const sampleDiagram = `flowchart LR
  User[User]
  Desktop[Hermes Desktop]
  Bridge[Rust and Python Bridge]
  Agent[Hermes Agent]
  Memory[(MEMORY.md and USER.md)]
  Skills[Skills]

  User --> Desktop --> Bridge --> Agent
  Agent --> Memory
  Agent --> Skills
  Skills --> Desktop
  Memory --> Desktop`;

export function defaultPreviewSource(mode: PreviewMode) {
  if (mode === "react") return sampleReact;
  if (mode === "markdown") return sampleMarkdown;
  if (mode === "diagram") return sampleDiagram;
  return sampleHtml;
}
