import { useEffect } from "react";
import { router } from "expo-router";
import { ConnectionStatusScreen } from "../src/screens/ConnectionStatusScreen";
import { useIrisConnection } from "../src/connection/useIrisConnection";

export default function IndexRoute() {
  const { state } = useIrisConnection();

  useEffect(() => {
    if (state.status === "unpaired") {
      router.replace("/pair");
      return;
    }
    if (state.status !== "connecting") {
      router.replace("/projects");
    }
  }, [state.status]);

  return <ConnectionStatusScreen />;
}
