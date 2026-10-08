import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../hands/remote/", import.meta.url));
const target = fileURLToPath(new URL("../.generated/hand/", import.meta.url));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(`${source}/image/labwc`, `${target}/labwc`, { recursive: true });

const toolkit = fileURLToPath(new URL("../../../crates/nanocodex-vm/image/toolkit/", import.meta.url));
const toolkitTarget = fileURLToPath(new URL("../.generated/toolkit/", import.meta.url));
await rm(toolkitTarget, { recursive: true, force: true });
await cp(toolkit, toolkitTarget, { recursive: true });
