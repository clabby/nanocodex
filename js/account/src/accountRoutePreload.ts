// The account route (connections, vault, wallet) is a lazy chunk. Load it on
// demand and warm it on navigation intent so following an Account link does
// not wait on a cold fetch after the click.
let deviceConnectModule: Promise<typeof import("./DeviceConnect")> | undefined;
export function loadDeviceConnect(): Promise<typeof import("./DeviceConnect")> {
  deviceConnectModule ??= import("./DeviceConnect").catch((error: unknown) => {
    deviceConnectModule = undefined;
    throw error;
  });
  return deviceConnectModule;
}

export function preloadDeviceConnect(): void {
  void loadDeviceConnect().catch(() => undefined);
}

/** Link props that warm the account route on hover, focus or press. */
export const accountRouteIntent = {
  onFocus: preloadDeviceConnect,
  onPointerEnter: preloadDeviceConnect,
  onPointerDown: preloadDeviceConnect,
} as const;
