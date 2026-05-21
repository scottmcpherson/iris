export const ASSISTANT_THINKING_TEXT = "Thinking";

const LEGACY_ASSISTANT_THINKING_TEXT = "Thinking...";

export function isAssistantThinkingPlaceholder(content: string) {
  const trimmed = content.trim();
  return trimmed === ASSISTANT_THINKING_TEXT || trimmed === LEGACY_ASSISTANT_THINKING_TEXT;
}
