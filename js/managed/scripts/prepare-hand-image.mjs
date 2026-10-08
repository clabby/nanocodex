import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Stage the shared VM toolkit into the sandbox image build context.
const toolkit = fileURLToPath(new URL("../../../crates/nanocodex-vm/image/toolkit/", import.meta.url));
const toolkitTarget = fileURLToPath(new URL("../.generated/toolkit/", import.meta.url));
await rm(toolkitTarget, { recursive: true, force: true });
await cp(toolkit, toolkitTarget, { recursive: true });
