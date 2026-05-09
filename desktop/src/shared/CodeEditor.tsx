export type CodeEditorMetadata = {
  label: string;
  value: string;
};

export type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  spellCheck?: boolean;
  metadata?: CodeEditorMetadata[];
  className?: string;
};

export function CodeEditor({
  value,
  onChange,
  spellCheck = false,
  metadata = [],
  className = "",
}: CodeEditorProps) {
  return (
    <div className={className ? `code-editor-wrap ${className}` : "code-editor-wrap"}>
      {metadata.length ? (
        <div className="syntax-strip">
          {metadata.map((item) => (
            <span key={item.label}>{item.value}</span>
          ))}
        </div>
      ) : null}
      <div className="skill-code-editor">
        <pre aria-hidden="true">{lineNumbers(value)}</pre>
        <textarea
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
