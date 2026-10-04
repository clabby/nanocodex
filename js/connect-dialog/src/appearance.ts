import type { ConnectAppearance } from "nanocodex-connect-ui/App";

// Query strings are untrusted. Keep these visual-token limits aligned with
// Dialog.iframe/popup and the Connect UI; malformed input uses native defaults.
export function appearanceFromSearch(search: string): ConnectAppearance | undefined {
  const parameters = new URLSearchParams(search).getAll("nanocodex_appearance");
  if (parameters.length !== 1 || parameters[0].length > 1024) return undefined;
  try {
    const value: unknown = JSON.parse(parameters[0]);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const keys = ["theme", "accentColor", "fontFamily", "borderRadius"];
    if (Object.keys(value).some(key => !keys.includes(key))) return undefined;
    const { theme, accentColor, fontFamily, borderRadius } = value as Record<string, unknown>;
    if (theme !== undefined && theme !== "light" && theme !== "dark" && theme !== "system") return undefined;
    if (accentColor !== undefined && (typeof accentColor !== "string" || !/^#[\da-f]{6}$/i.test(accentColor))) return undefined;
    if (fontFamily !== undefined && (typeof fontFamily !== "string" || fontFamily.length > 160
      || !/^[a-zA-Z0-9 ,"'_-]+$/.test(fontFamily) || !fontFamily.trim())) return undefined;
    if (borderRadius !== undefined && (typeof borderRadius !== "number" || !Number.isFinite(borderRadius)
      || borderRadius < 0 || borderRadius > 24)) return undefined;
    return value as ConnectAppearance;
  } catch {
    return undefined;
  }
}
