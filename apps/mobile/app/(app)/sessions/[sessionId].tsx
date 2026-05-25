import { Stack } from "expo-router";
import { ChatScreen } from "../../../src/screens/ChatScreen";

export default function SessionDetailRoute() {
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
      <ChatScreen />
    </>
  );
}
