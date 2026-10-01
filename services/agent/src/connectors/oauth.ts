import { randomBytes } from "node:crypto";
import { auth, type FetchLike, type OAuthClientInformationContext, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { clearConnectorOAuth, getConnectorOAuth, getConnectorRow, saveConnectorDiscovery, saveConnectorOAuth } from "@openlive/db";

// OAuth for http connectors: authorization code with PKCE, the redirect landing
// on this server's own loopback port. Tokens and client credentials live in the
// connector store, encrypted and filed by issuer; they never leave this process,
// not even to an ACP agent, which reaches the tools only through OpenLive's MCP.

export const OAUTH_CALLBACK_PATH = "/connectors/oauth/callback";

/** Loopback by IP, not `localhost`: RFC 8252 §7.3, and what authorization servers accept without a registered host. */
export const redirectUrl = (): string => `http://127.0.0.1:${process.env.AGENT_PORT ?? 8787}${OAUTH_CALLBACK_PATH}`;

/** A sign-in the user has this long to finish in the browser. */
const FLOW_TTL_MS = 10 * 60_000;

export class ConnectorOAuth implements OAuthClientProvider {
  private verifier = "";
  /** Where the user goes to sign in. Only ever set; a background connect never opens anything. */
  authorizationUrl: URL | null = null;

  constructor(private readonly id: string, readonly redirectUrl: string, private readonly flowState?: string) {}

  get clientMetadataUrl(): string | undefined { return getConnectorRow(this.id)?.clientMetadataUrl; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "OpenLive",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string { return this.flowState ?? randomBytes(24).toString("base64url"); }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const info = getConnectorOAuth<StoredOAuthClientInformation & { redirect_uris?: unknown }>(this.id, "client", ctx?.issuer);
    // Registered for a redirect on another port (the agent's port can move):
    // register again rather than be refused at the callback.
    if (Array.isArray(info?.redirect_uris) && !info.redirect_uris.includes(this.redirectUrl)) return undefined;
    return info;
  }

  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer ?? info.issuer;
    if (issuer) await saveConnectorOAuth(this.id, "client", issuer, info);
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return getConnectorOAuth<StoredOAuthTokens>(this.id, "tokens", ctx?.issuer);
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer ?? tokens.issuer;
    if (issuer) await saveConnectorOAuth(this.id, "tokens", issuer, tokens);
  }

  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }

  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }

  discoveryState(): OAuthDiscoveryState | undefined {
    return getConnectorRow(this.id)?.oauth?.discovery as OAuthDiscoveryState | undefined;
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> { await saveConnectorDiscovery(this.id, state); }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") { this.verifier = ""; return; }
    await clearConnectorOAuth(this.id, scope);
  }
}

const flows = new Map<string, { id: string; provider: ConnectorOAuth; at: number }>();

/**
 * Begin signing a connector in. Resolves the page to open, or `authorized`
 * when a stored refresh token was enough. The URL goes back to the caller (the
 * UI), which opens it the way it opens every link, so this works in the desktop
 * app and in a browser tab alike without the server reaching for a window.
 */
export async function startSignIn(id: string, serverUrl: string, fetchFn?: FetchLike): Promise<{ authorizationUrl: string } | { authorized: true }> {
  const now = Date.now();
  for (const [state, f] of flows) if (now - f.at > FLOW_TTL_MS) flows.delete(state); // O(open sign-ins)
  const state = randomBytes(24).toString("base64url");
  const provider = new ConnectorOAuth(id, redirectUrl(), state);
  // A deliberate sign-in rediscovers, so a server that moved its authorization server is followed.
  await provider.invalidateCredentials("discovery");
  if (await auth(provider, { serverUrl, fetchFn }) === "AUTHORIZED") return { authorized: true };
  if (!provider.authorizationUrl) throw new Error("The server did not offer a sign-in page.");
  flows.set(state, { id, provider, at: now });
  return { authorizationUrl: provider.authorizationUrl.href };
}

/**
 * Finish a sign-in from the redirect's query. The state names the flow and is
 * spent on first use; the SDK checks `iss` against the issuer recorded when the
 * flow began (RFC 9207) before it redeems the code. Resolves the connector id.
 */
export async function finishSignIn(params: URLSearchParams, serverUrl: (id: string) => string | undefined, fetchFn?: FetchLike): Promise<string> {
  const flow = flows.get(params.get("state") ?? "");
  if (!flow || Date.now() - flow.at > FLOW_TTL_MS) throw new Error("This sign-in link has expired. Start again from OpenLive.");
  flows.delete(params.get("state")!);
  const url = serverUrl(flow.id);
  if (!url) throw new Error("That connector was removed.");
  // The callback's own error text is the authorization server's to write, and
  // in a mix-up attack someone else's: it is never shown.
  const code = params.get("code");
  if (!code) throw new Error("The sign-in was not completed.");
  await auth(flow.provider, { serverUrl: url, authorizationCode: code, iss: params.get("iss") ?? undefined, fetchFn });
  return flow.id;
}
