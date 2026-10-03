/** Synthetic provider boundary; production OAuth/runtime code is not stubbed. */
export function claudeProvider(request: {url: string; method: string; headers: {get(name: string): string | null; has(name: string): boolean}; json(): Promise<unknown>}): Promise<Response | undefined>;
