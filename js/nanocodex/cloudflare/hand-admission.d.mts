/** Finite RPC data: no Request streams or upgrade handles cross the service boundary. */
export type HandViewerRequest = Readonly<{ url: string; method: string; headers: [string, string][] }>;
/** Private service result. Requests retain the original public origin during authorization. */
export type PreparedHandViewer = Readonly<{
  ownerId: string;
  request: HandViewerRequest;
  headers: [string, string][];
}>;
export type HandViewerAdmissionBinding = Readonly<{
  prepare(request: HandViewerRequest): Promise<Response | PreparedHandViewer>;
}>;
export type HandViewerBrokerNamespace = Readonly<{
  getByName(ownerId: string): Readonly<{ fetch(request: Request): Promise<Response> }>;
}>;
/** Only initial account viewer upgrades; publishing and renewal keep their existing paths. */
export declare function isHandViewerUpgrade(request: Request): boolean;
/** Authorize centrally, then forward one upgrade to the account-owned broker. Never retries. */
export declare function forwardHandViewerUpgrade(request: Request, admission: HandViewerAdmissionBinding,
  brokers: HandViewerBrokerNamespace): Promise<Response>;
