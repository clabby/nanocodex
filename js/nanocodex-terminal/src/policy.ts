export const COARSE_POINTER_QUERY = "(pointer: coarse), (any-pointer: coarse)";

export function terminalComposerAction(running: boolean, _draft: string): "send" | "stop" {
  return running ? "stop" : "send";
}

/** Phones and tablets without a hover pointer: Enter adds a line, the button sends. */
export const TOUCH_KEYBOARD_QUERY = "(pointer: coarse) and (hover: none)";
