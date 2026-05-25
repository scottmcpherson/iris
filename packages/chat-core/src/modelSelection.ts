export type ChatModelSelection = {
  provider?: string;
  model: string;
};

export function shouldSendModelSwitch(
  selected: ChatModelSelection | null,
  current: ChatModelSelection | null,
) {
  if (!selected?.model) return false;
  if (!current?.model) return true;
  if (selected.model !== current.model) return true;
  return Boolean(selected.provider && current.provider && selected.provider !== current.provider);
}

export function modelSwitchSelectionForSend(
  selected: ChatModelSelection | null,
  current: ChatModelSelection | null,
) {
  return shouldSendModelSwitch(selected, current) ? selected : null;
}
