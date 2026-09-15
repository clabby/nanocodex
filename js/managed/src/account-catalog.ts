import { fetchResponseWithDeadline } from "./deadline";

/** One live read shared by runtime discovery and first-turn environment context. */
export function accountCatalog(broker: Fetcher, userId: string): Promise<unknown> {
  return fetchResponseWithDeadline(
    broker,
    `https://broker.internal/users/${encodeURIComponent(userId)}/catalog`,
    {},
    10_000,
    "account catalog",
    async (response) => {
      if (!response.ok) throw new Error(`account catalog failed with HTTP ${response.status}`);
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)
        || !("connectors" in value) || !value.connectors || typeof value.connectors !== "object"
        || Array.isArray(value.connectors)
        || !("mcp_connections" in value) || !Array.isArray(value.mcp_connections)) {
        throw new Error("account catalog returned an invalid response");
      }
      return value;
    },
  );
}
