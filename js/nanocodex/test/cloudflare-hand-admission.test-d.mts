import { forwardHandViewerUpgrade, isHandViewerUpgrade, type HandViewerAdmissionBinding, type HandViewerBrokerNamespace, type PreparedHandViewer } from "nanocodex/cloudflare/hand-admission";
const prepared: PreparedHandViewer = { ownerId: "account", request: new Request("https://internal.test"), headers: [["cache-control", "no-store"]] };
const admission: HandViewerAdmissionBinding = { prepare: async () => prepared };
const brokers: HandViewerBrokerNamespace = { getByName: () => ({ fetch: async () => new Response() }) };
const selected: boolean = isHandViewerUpgrade(prepared.request);
const response: Promise<Response> = forwardHandViewerUpgrade(prepared.request, admission, brokers);
void selected; void response;
