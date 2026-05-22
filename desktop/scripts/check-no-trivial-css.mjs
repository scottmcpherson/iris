#!/usr/bin/env node
/**
 * Fails if a single-class CSS rule contains only utility-mappable
 * declarations (per the trivial-set in
 * .plans/2026-05-22-css-architecture-cleanup.md). Use this to keep new "named
 * layout shorthand" rules from creeping back into the codebase — write them as
 * Tailwind utilities at the call site instead.
 *
 * Scans .css under desktop/src/. Compares findings against the grandfathered
 * baseline at scripts/trivial-css-baseline.json. Exits non-zero if a violation
 * is found that isn't in the baseline.
 *
 * Allowlist:
 *   - A comment `\/* trivial-allowlist: <reason> *\/` in the rule body keeps
 *     it from triggering (preferred for new exceptions).
 *   - Run with `--update-baseline` to rewrite the grandfathered list to match
 *     the current state. Use sparingly; the goal is to shrink that list, not
 *     grow it.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/", import.meta.url));

// CSS properties the trivial classifier considers utility-mappable.
const TRIVIAL_PROPS = new Set([
  "display", "flex-direction", "flex-wrap", "flex", "flex-grow", "flex-shrink", "flex-basis",
  "align-items", "align-self", "justify-content", "justify-items", "justify-self",
  "align-content", "place-items", "place-content", "place-self",
  "gap", "row-gap", "column-gap",
  "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
  "padding-inline", "padding-block",
  "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
  "margin-inline", "margin-block",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "border-radius",
  "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
  "overflow", "overflow-x", "overflow-y",
  "position", "top", "right", "bottom", "left", "inset", "z-index",
  "opacity", "cursor", "user-select", "pointer-events", "box-sizing",
  "white-space", "text-overflow", "word-break", "overflow-wrap",
  "appearance", "resize", "object-fit", "list-style",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

function parseRules(text) {
  const rules = [];
  const lines = text.split("\n");
  let i = 0;
  let selBuf = [];
  let selStart = null;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();
    if (!selBuf.length && (stripped === "" || stripped.startsWith("//") || stripped.startsWith("/*") || stripped.startsWith("@import") || stripped.startsWith("@source") || stripped.startsWith("@custom-variant"))) {
      i++;
      continue;
    }
    if (line.includes("{")) {
      const pre = line.split("{", 2)[0];
      const selector = (selBuf.length ? selBuf.join(" ") + " " : "") + pre.trim();
      const start = selStart ?? (i + 1);
      let depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      let j = i;
      while (depth > 0) {
        j++;
        if (j >= lines.length) break;
        depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      }
      const end = j + 1;
      const body = lines.slice(start - 1, end).join("\n");
      rules.push({ start, end, selector: selector.replace(/\s+/g, " ").trim(), body });
      selBuf = [];
      selStart = null;
      i = j + 1;
      continue;
    }
    if (selStart === null) selStart = i + 1;
    selBuf.push(stripped);
    i++;
  }
  return rules;
}

function isSingleClassSelector(selector) {
  const parts = selector.split(",").map((s) => s.trim());
  return parts.every((p) => /^\.[a-zA-Z][a-zA-Z0-9_-]*$/.test(p));
}

function parseDeclarations(body) {
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  if (open < 0 || close < 0) return [];
  const inner = body.slice(open + 1, close);
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out
    .filter((d) => d.includes(":"))
    .map((d) => {
      const idx = d.indexOf(":");
      return { prop: d.slice(0, idx).trim().toLowerCase(), value: d.slice(idx + 1).trim() };
    });
}

function isTrivialRule(rule) {
  if (!isSingleClassSelector(rule.selector)) return false;
  if (rule.body.includes("trivial-allowlist:")) return false;
  const decls = parseDeclarations(rule.body);
  if (!decls.length) return false;
  return decls.every((d) => TRIVIAL_PROPS.has(d.prop));
}

const DESKTOP_DIR = fileURLToPath(new URL("../", import.meta.url));
const files = walk(ROOT);
const violations = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rules = parseRules(text);
  for (const rule of rules) {
    if (isTrivialRule(rule)) {
      violations.push({ file: relative(DESKTOP_DIR, file), line: rule.start, selector: rule.selector });
    }
  }
}

const baselinePath = fileURLToPath(new URL("./trivial-css-baseline.json", import.meta.url));
const updateBaseline = process.argv.includes("--update-baseline");

// Baseline key: `${file}::${selector}` — line numbers shift, so we don't include them.
const violationKey = (v) => `${v.file}::${v.selector}`;
const currentKeys = new Set(violations.map(violationKey));

if (updateBaseline) {
  const baseline = violations.map((v) => ({ file: v.file, selector: v.selector }));
  baseline.sort((a, b) => (a.file + a.selector).localeCompare(b.file + b.selector));
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Wrote ${baseline.length} grandfathered violations to ${relative(process.cwd(), baselinePath)}.`);
  process.exit(0);
}

let baselineKeys = new Set();
if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  baselineKeys = new Set(baseline.map((v) => `${v.file}::${v.selector}`));
}

const novel = violations.filter((v) => !baselineKeys.has(violationKey(v)));
const stale = [...baselineKeys].filter((k) => !currentKeys.has(k));

if (novel.length === 0 && stale.length === 0) {
  console.log(`OK: no new trivial-only CSS rules. (${violations.length} grandfathered.)`);
  process.exit(0);
}

if (novel.length > 0) {
  console.error(`\n${novel.length} new CSS rule${novel.length === 1 ? "" : "s"} contain only utility-mappable properties:\n`);
  for (const v of novel) {
    console.error(`  ${v.file}:${v.line}  ${v.selector}`);
  }
  console.error(
    `\nWrite these as Tailwind utilities at the call site instead of named CSS rules.\nIf a rule truly must stay as CSS, add a comment with \`trivial-allowlist: <reason>\` inside its body.\nSee .plans/2026-05-22-css-architecture-cleanup.md for the property list and rationale.\n`,
  );
}

if (stale.length > 0) {
  console.error(`\n${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} no longer present:`);
  for (const key of stale) console.error(`  ${key}`);
  console.error(`\nRun \`node scripts/check-no-trivial-css.mjs --update-baseline\` to refresh the grandfathered list.\n`);
}

process.exit(1);
