import { cn } from "./ui/utils";

export type CodeEditorMetadata = {
  label: string;
  value: string;
};

export type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  spellCheck?: boolean;
  readOnly?: boolean;
  metadata?: CodeEditorMetadata[];
  className?: string;
};

export function CodeEditor({
  value,
  onChange,
  spellCheck = false,
  readOnly = false,
  metadata = [],
  className = "",
}: CodeEditorProps) {
  return (
    <div className={cn("grid grid-rows-[auto_minmax(0,1fr)] min-h-0", className)}>
      {metadata.length ? (
        <div className="syntax-strip">
          {metadata.map((item) => (
            <span key={item.label}>{item.value}</span>
          ))}
        </div>
      ) : null}
      <div className="skill-code-editor grid grid-cols-[44px_minmax(0,1fr)] min-h-0">
        <pre aria-hidden="true">{lineNumbers(value)}</pre>
        <textarea
          readOnly={readOnly}
          spellCheck={spellCheck}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function lineNumbers(content: string) {
  return content
    .split("\n")
    .map((_, index) => index + 1)
    .join("\n");
}
