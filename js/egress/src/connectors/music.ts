export type MusicProviderId = "spotify" | "soundcloud";

// Public PKCE registration used by ncspot and spotify-player. Its registered
// loopback redirect is fixed; callers cannot supply another client or destination.
export const SPOTIFY_LOOPBACK_CLIENT_ID = "d420a117a32841c2b3474932e49fb54b";
export const SPOTIFY_LOOPBACK_REDIRECT_URI = "http://127.0.0.1:8989/login";

// Spotify Web API scopes; playback itself remains subject to Spotify's account restrictions.
export const SPOTIFY_SCOPES = Object.freeze([
  "user-library-read", "user-library-modify",
  "playlist-read-private", "playlist-read-collaborative", "playlist-modify-public",
  "playlist-modify-private", "user-follow-read", "user-follow-modify",
  "user-top-read", "user-read-recently-played", "user-read-playback-state",
  "user-read-currently-playing", "user-modify-playback-state",
]);

const PROVIDERS = {
  spotify: {
    authorization: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    identity: "https://api.spotify.com/v1/me",
  },
  soundcloud: {
    authorization: "https://secure.soundcloud.com/authorize",
    token: "https://secure.soundcloud.com/oauth/token",
    identity: "https://api.soundcloud.com/me",
  },
} as const;

export function buildMusicAuthorizationUrl(id: MusicProviderId, input: {
  clientId: string; redirectUri: string; state: string; codeChallenge: string;
}): URL {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw new Error("invalid PKCE challenge");
  const url = new URL(PROVIDERS[id].authorization);
  url.search = new URLSearchParams({
    response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri,
    state: input.state, code_challenge: input.codeChallenge, code_challenge_method: "S256",
    ...(id === "spotify" ? { scope: SPOTIFY_SCOPES.join(" ") } : { display: "popup" }),
  }).toString();
  return url;
}

export function buildMusicTokenRequest(id: MusicProviderId, input: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string;
}): Request {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new Error("invalid PKCE verifier");
  return tokenRequest(id, input, {
    grant_type: "authorization_code", code: input.code,
    redirect_uri: input.redirectUri, code_verifier: input.codeVerifier,
  });
}

export function buildMusicRefreshRequest(id: MusicProviderId, input: {
  clientId: string; clientSecret: string; refreshToken: string;
}): Request {
  return tokenRequest(id, input, { grant_type: "refresh_token", refresh_token: input.refreshToken });
}

function tokenRequest(id: MusicProviderId, credentials: {
  clientId: string; clientSecret: string;
}, fields: Record<string, string>): Request {
  return new Request(PROVIDERS[id].token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...fields, client_id: credentials.clientId,
      ...(id === "soundcloud" ? { client_secret: credentials.clientSecret } : {}),
    }),
  });
}

export function decodeMusicTokenResponse(id: MusicProviderId, value: unknown, previousScopes?: readonly string[]) {
  const response = record(value);
  if (typeof response.access_token !== "string" || !response.access_token
    || typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer"
    || !Number.isSafeInteger(response.expires_in) || (response.expires_in as number) <= 0
    || (response.refresh_token !== undefined && (typeof response.refresh_token !== "string" || !response.refresh_token))
    || ((previousScopes === undefined || id === "soundcloud") && !response.refresh_token)
    || (response.scope !== undefined && typeof response.scope !== "string")) {
    throw new Error(`invalid ${id} token response`);
  }
  const scopes = typeof response.scope === "string"
    ? response.scope.trim().split(/\s+/).filter(Boolean)
    : [...(previousScopes ?? [])];
  if (scopes.some((scope) => !/^[A-Za-z0-9._:-]+$/.test(scope))
    || (id === "spotify" && SPOTIFY_SCOPES.some((scope) => !scopes.includes(scope)))) {
    throw new Error(`invalid ${id} token scopes`);
  }
  return {
    accessToken: response.access_token,
    ...(typeof response.refresh_token === "string" ? { refreshToken: response.refresh_token } : {}),
    expiresIn: response.expires_in as number, scopes,
  };
}

export function buildMusicIdentityRequest(id: MusicProviderId, accessToken: string): Request {
  return new Request(PROVIDERS[id].identity, {
    headers: { accept: "application/json", authorization: `${id === "soundcloud" ? "OAuth" : "Bearer"} ${accessToken}` },
  });
}

export function decodeMusicIdentity(id: MusicProviderId, value: unknown) {
  const response = record(value);
  const accountId = id === "soundcloud" && typeof response.urn === "string"
    ? response.urn
    : typeof response.id === "string" ? response.id
      : id === "soundcloud" && Number.isSafeInteger(response.id) && (response.id as number) > 0 ? String(response.id) : "";
  const label = id === "spotify" ? response.display_name : response.username;
  if (!accountId || accountId.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(accountId)) {
    throw new Error(`invalid ${id} identity`);
  }
  return {
    accountId,
    displayLabel: typeof label === "string" && label.trim() ? label.trim().slice(0, 256) : accountId,
  };
}

export function buildSoundCloudRevocationRequest(accessToken: string): Request {
  return new Request("https://secure.soundcloud.com/sign-out", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider response");
  return value as Record<string, unknown>;
}
