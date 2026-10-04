import type { CSSProperties } from "react";

/** Visual tokens only; appearance never changes identity or requested access. */
export type ConnectAppearance = Readonly<{
  theme?: "light" | "dark" | "system";
  accentColor?: string;
  /** Installed fonts or fonts loaded by a self-hosted Connect page. */
  fontFamily?: string;
  /** Control corner radius in pixels, from 0 to 24. */
  borderRadius?: number;
}>;

export function appearanceStyle(appearance?: ConnectAppearance): CSSProperties {
  const style: Record<string, string> = {};
  if (!appearance || typeof appearance !== "object") return style;
  if (appearance.theme === "light" || appearance.theme === "dark") style.colorScheme = appearance.theme;
  if (appearance.theme === "system") style.colorScheme = "light dark";
  if (typeof appearance.accentColor === "string" && /^#[\da-f]{6}$/i.test(appearance.accentColor)) {
    const color = appearance.accentColor;
    const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
      .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    const luminance = .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
    style["--connect-accent"] = color;
    style["--connect-on-accent"] = luminance > .179 ? "#000000" : "#ffffff";
  }
  if (typeof appearance.fontFamily === "string" && appearance.fontFamily.length <= 160
    && /^[a-zA-Z0-9 ,"'_-]+$/.test(appearance.fontFamily) && appearance.fontFamily.trim()) style["--connect-font"] = appearance.fontFamily;
  if (typeof appearance.borderRadius === "number" && Number.isFinite(appearance.borderRadius)
    && appearance.borderRadius >= 0 && appearance.borderRadius <= 24) style["--connect-radius"] = `${appearance.borderRadius}px`;
  return style as CSSProperties;
}
