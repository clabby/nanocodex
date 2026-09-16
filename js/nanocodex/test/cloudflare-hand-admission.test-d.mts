import { forwardHandViewerUpgrade, isHandViewerUpgrade, type HandViewerAdmissionBinding, type HandViewerBrokerNamespace, type PreparedHandViewer } from "nanocodex/cloudflare/hand-admission";
const prepared: PreparedHandViewer = { ownerId: "account", request: { url: "https://internal.test", method: "GET", headers: [] }, headers: [["cache-control", "no-store"]] };
const admission: HandViewerAdmissionBinding = { prepare: async () => prepared };
const brokers: HandViewerBrokerNamespace = { getByName: () => ({ fetch: async () => new Response() }) };
const selected: boolean = isHandViewerUpgrade(new Request(prepared.request.url));
const response: Promise<Response> = forwardHandViewerUpgrade(new Request(prepared.request.url), admission, brokers);
void selected; void response;
