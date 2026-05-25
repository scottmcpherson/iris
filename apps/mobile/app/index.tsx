import { useEffect } from "react";
import { router } from "expo-router";
import { ConnectionStatusScreen } from "../src/screens/ConnectionStatusScreen";
import { useIrisConnection } from "../src/connection/useIrisConnection";

export default function IndexRoute() {
  const { state } = useIrisConnection();

  useEffect(() => {
    if (state.status !== "connecting") {
      router.replace("/sessions/new");
    }
  }, [state.status]);

  return <ConnectionStatusScreen />;
}
