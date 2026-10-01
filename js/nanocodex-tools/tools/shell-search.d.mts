import type { JustBashCustomCommand } from "./bash.mjs";
export function createSearchCommands(options: { Bash: typeof import("just-bash/browser").Bash }): JustBashCustomCommand[];
