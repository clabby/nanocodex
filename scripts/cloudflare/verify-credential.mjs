// Read-only diagnostic: never print credentials, raw responses, or headers.
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !/^[a-f0-9]{32}$/.test(account ?? "")) {
  console.error("Missing diagnostic configuration");
  process.exit(1);
}
for (const [kind, path] of [["user", "/user/tokens/verify"], ["account", `/accounts/${account}/tokens/verify`]]) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    const result = value?.result;
    const status = ["active", "disabled", "expired"].includes(result?.status) ? result.status : "other";
    const expiry = result?.expires_on;
    console.log(JSON.stringify({ kind, http_status: response.status, success: value?.success === true,
      token_status: status, id_valid: typeof result?.id === "string" && /^[a-f0-9]{32}$/.test(result.id),
      expiry_type: expiry === null ? "null" : typeof expiry }));
  } catch {
    console.log(JSON.stringify({ kind, diagnostic: "request_failed" }));
    process.exitCode = 1;
  }
}
