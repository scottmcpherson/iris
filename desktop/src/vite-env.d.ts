/// <reference types="vite/client" />

declare module "@babel/standalone" {
  type TransformOptions = {
    filename?: string;
    presets?: Array<string | [string, Record<string, unknown>]>;
  };

  type TransformResult = {
    code?: string;
  };

  export function transform(source: string, options?: TransformOptions): TransformResult;
}

declare module "virtual:preview-runtime/mermaid" {
  const runtime: string;
  export default runtime;
}

declare module "virtual:preview-runtime/react" {
  const runtime: string;
  export default runtime;
}

declare module "virtual:preview-runtime/react-dom" {
  const runtime: string;
  export default runtime;
}
