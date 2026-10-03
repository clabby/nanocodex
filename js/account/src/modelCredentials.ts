type ChatGptAccount = Readonly<{
  accountId: string;
  connected: boolean;
  active: boolean;
  limitedUntil?: number;
}>;

export type CredentialStatus = Readonly<{
  ready: boolean;
  active: "openai" | "chatgpt" | "claude" | null;
  claude: { connected: boolean; pending?: boolean; login?: { expiresAt: number } };
  openai: { connected: boolean };
  chatgpt: {
    connected: boolean;
    accountId?: string;
    accounts: readonly ChatGptAccount[];
    login?: {
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
      pollAfterMs: number;
    };
  };
}>;

export function decodeCredentialStatus(value: unknown): CredentialStatus {
  if (!isRecord(value) || !isRecord(value.openai) || !isRecord(value.chatgpt)) {
    throw new Error("Invalid model connection response.");
  }
  const active = value.active === "openai" || value.active === "chatgpt" || value.active === "claude" ? value.active : null;
  if (typeof value.ready !== "boolean"
    || typeof value.openai.connected !== "boolean"
    || typeof value.chatgpt.connected !== "boolean") {
    throw new Error("Invalid model connection response.");
  }
  const login = value.chatgpt.login === undefined
    ? undefined
    : decodeChatGptLogin(value.chatgpt.login);
  const claude = value.claude === undefined ? { connected: false } : decodeClaudeStatus(value.claude);
  return {
    ready: value.ready,
    active,
    claude,
    openai: { connected: value.openai.connected },
    chatgpt: {
      connected: value.chatgpt.connected,
      accounts: decodeChatGptAccounts(value.chatgpt, active),
      ...(typeof value.chatgpt.account_id === "string" ? { accountId: value.chatgpt.account_id } : {}),
      ...(login ? { login } : {}),
    },
  };
}

export function decodeChatGptLogin(value: unknown): NonNullable<CredentialStatus["chatgpt"]["login"]> {
  if (!isRecord(value)
    || value.state !== "pending"
    || typeof value.verification_url !== "string"
    || typeof value.user_code !== "string"
    || typeof value.expires_at !== "number"
    || typeof value.poll_after_ms !== "number") {
    throw new Error("Invalid ChatGPT sign-in response.");
  }
  return {
    verificationUrl: value.verification_url,
    userCode: value.user_code,
    expiresAt: value.expires_at,
    pollAfterMs: value.poll_after_ms,
  };
}

function decodeChatGptAccounts(value: Record<string, unknown>, active: CredentialStatus["active"]): ChatGptAccount[] {
  // Keep older deployments visible while the account pool rolls out.
  if (value.accounts === undefined) {
    return typeof value.account_id === "string" ? [{
      accountId: value.account_id, connected: value.connected === true, active: active === "chatgpt",
    }] : [];
  }
  if (!Array.isArray(value.accounts)) throw new Error("Invalid ChatGPT account list.");
  return value.accounts.map((account) => {
    if (!isRecord(account) || typeof account.account_id !== "string" || !account.account_id
      || typeof account.connected !== "boolean" || typeof account.active !== "boolean"
      || (account.limited_until !== undefined && (typeof account.limited_until !== "number"
        || !Number.isFinite(account.limited_until)))) {
      throw new Error("Invalid ChatGPT account list.");
    }
    return {
      accountId: account.account_id, connected: account.connected, active: account.active,
      ...(typeof account.limited_until === "number" ? { limitedUntil: account.limited_until } : {}),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeClaudeStatus(value: unknown): CredentialStatus["claude"] {
  if (!isRecord(value) || typeof value.connected !== "boolean") {
    throw new Error("Invalid Claude connection response.");
  }
  if (value.login === undefined || value.login === null) return { connected: value.connected, pending: value.state === "pending" };
  if (!isRecord(value.login) || value.login.state !== "pending"
    || typeof value.login.expires_at !== "number" || !Number.isFinite(value.login.expires_at)) {
    throw new Error("Invalid Claude connection response.");
  }
  return { connected: value.connected, pending: true, login: { expiresAt: value.login.expires_at } };
}

/** Authorization destinations are shown only after an explicit UI action, never in account status. */
export function decodeClaudeLogin(value: unknown): { authorizationUrl: string; expiresAt: number } {
  if (!isRecord(value)
    || typeof value.authorization_url !== "string"
    || typeof value.expires_at !== "number" || !Number.isFinite(value.expires_at)) {
    throw new Error("Invalid Claude sign-in response.");
  }
  const url = new URL(value.authorization_url);
  const keys = ["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"];
  const query = [...url.searchParams];
  // `code=true` is the provider's public authorize-page flag, never an authorization code.
  if (url.origin !== "https://claude.com" || url.pathname !== "/cai/oauth/authorize"
    || url.username || url.password || url.hash || url.port || value.authorization_url.length > 4096
    || query.length !== keys.length || new Set(query.map(([key]) => key)).size !== keys.length
    || query.some(([key]) => !keys.includes(key))
    || url.searchParams.get("code") !== "true"
    || url.searchParams.get("client_id") !== "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    || url.searchParams.get("redirect_uri") !== "https://platform.claude.com/oauth/code/callback"
    || url.searchParams.get("scope") !== "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"
    || url.searchParams.get("response_type") !== "code"
    || url.searchParams.get("code_challenge_method") !== "S256"
    || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "")) {
    throw new Error("Invalid Claude sign-in destination.");
  }
  return { authorizationUrl: value.authorization_url, expiresAt: value.expires_at };
}
