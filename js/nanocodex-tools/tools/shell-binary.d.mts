/** Optional range storage. Absolute paths have already passed root confinement.
 * Range writes/truncation MUST also maintain the shell filesystem metadata.
 * No callback is retried automatically after a write has been requested.
 */
export type ShellBinaryIO = Readonly<{
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeRange?(path: string, offset: number, contents: Uint8Array): Promise<void>;
  truncate?(path: string, size: number): Promise<void>;
}>;
export type ShellBinaryFileSystem = Readonly<{
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
  readdir?(path: string): Promise<string[]>;
  lstat(path: string): Promise<Readonly<{
    isFile: boolean;
    isDirectory?: boolean;
    isSymbolicLink: boolean;
    size: number;
  }>>;
}>;
/** Invoke within the existing execution lock, refresh and cancellation boundary.
 * Host must disable this fast path when cat/sha256sum have custom overrides.
 * Undefined means no effects occurred and normal interpreter execution is safe.
 * Admission uses the interpreter's real parser (Bash.transform), not token regexes.
 */
export declare function tryExecuteBinaryCommand(options: Readonly<{
  bash: { transform(command: string): { ast: unknown } };
  filesystem: ShellBinaryFileSystem;
  command: string;
  cwd: string;
  root: string;
  signal?: AbortSignal;
  binaryIO?: ShellBinaryIO;
  executionLimits?: Readonly<{ maxSourceBytes?: number; maxInputBytes?: number; maxLiveBytes?: number; maxOutputSize?: number }>;
}>): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
