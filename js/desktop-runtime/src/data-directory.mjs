import { join } from "node:path";
import { homedir } from "node:os";

export function desktopDataDirectory(environment = process.env, platform = process.platform, home = homedir()) {
  if (environment.NANOCODEX_DESKTOP_DATA) return environment.NANOCODEX_DESKTOP_DATA;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Nanocodex", "Native");
  if (platform === "win32") return join(environment.LOCALAPPDATA || join(home, "AppData", "Local"), "Nanocodex", "Native");
  return join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "nanocodex", "native");
}

export function runtimeDataDirectory(environment = process.env, platform = process.platform, home = homedir()) {
  // Preserve the existing macOS runtime state location. Other platforms share
  // their native recipe directory with the CLI helper.
  if (platform === "darwin" && !environment.NANOCODEX_DESKTOP_DATA) return join(home, "Library", "Application Support", "Nanocodex", "Runtime");
  return desktopDataDirectory(environment, platform, home);
}
