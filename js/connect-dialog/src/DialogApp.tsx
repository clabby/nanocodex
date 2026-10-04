import { useCallback, useSyncExternalStore } from "react";

import { ConnectOnboarding } from "nanocodex-connect-ui/App";
import { parentDialog } from "./protocol";
import { appearanceFromSearch } from "./appearance";

export function App() {
  const subscribe = useCallback(
    (listener: () => void) => parentDialog.subscribe?.(listener) ?? (() => {}),
    [],
  );
  const getSnapshot = useCallback(() => parentDialog.getRequest?.(), []);
  const request = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const appearance = appearanceFromSearch(window.location.search);
  return <ConnectOnboarding appearance={appearance} host={parentDialog} request={request} />;
}
