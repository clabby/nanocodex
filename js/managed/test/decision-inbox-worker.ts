// Isolated real account/CRM Worker. Deliberately excludes src/index and its
// QuickJS/session/deployment build graph; account persistence is not mocked.
export { ApiKeyRecord, NonceStorage, Organization, UserAccount } from "../src/account-auth";

export default {
  fetch() {
    return new Response("Decision inbox persistence test fixture", { status: 404 });
  },
};
