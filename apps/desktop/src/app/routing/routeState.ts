export function shouldResetSelectionForNewChatRoute({
  routeChanged,
  selectedSessionId,
}: {
  routeChanged: boolean;
  selectedSessionId: string | null;
}) {
  return routeChanged && Boolean(selectedSessionId);
}
