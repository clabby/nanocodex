/**
 * @internal Hook installed by `mcpPayment()` from `nanocodex/tempo`. Core MCP
 * code calls it to wrap a paid server's client without importing mppx itself.
 */
export const mcpPaymentWrap = Symbol.for("nanocodex.mcp.payment.wrap");
