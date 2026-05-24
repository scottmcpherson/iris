import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceCss = resolve(root, "src/desktop-tokens-source.css");
const desktopCss = resolve(root, "generated/desktop-tokens.css");
const nativeTheme = resolve(root, "generated/native-theme.ts");

await mkdir(resolve(root, "generated"), { recursive: true });

const css = await readFile(sourceCss, "utf8");
await writeFile(
  desktopCss,
  css.replace(
    '@source "../../node_modules/streamdown/dist/*.js";',
    '@source "../../../apps/desktop/node_modules/streamdown/dist/*.js";',
  ),
);

await writeFile(
  nativeTheme,
  [
    "export { irisNativeTheme } from \"../src/tokens\";",
    "export type { IrisNativeTheme } from \"../src/tokens\";",
    "",
  ].join("\n"),
);
