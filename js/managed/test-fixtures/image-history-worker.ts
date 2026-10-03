import { DurableObject } from "cloudflare:workers";
export class ImageHistory extends DurableObject {
  fetch(): Response { return new Response("image history fixture"); }
}
export default { fetch: () => new Response("image history fixture") };
