// The whole sign-in against a fake authorization server: discovery, dynamic
// registration, PKCE, the loopback callback, and the issuer check. No network:
// every request lands on the fetch below.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ol-oauth-"));
process.env.OPENLIVE_HOME = dir;
process.env.OPENLIVE_ENC_KEY = "ef".repeat(32);
process.env.AGENT_PORT = "47999";
const db = await import("@openlive/db");
const { finishSignIn, startSignIn, redirectUrl, ConnectorOAuth } = await import("./oauth.ts");

afterAll(() => {
  for (const k of ["OPENLIVE_HOME", "OPENLIVE_ENC_KEY", "AGENT_PORT"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

const MCP = "https://mcp.example.com/mcp";
const AS = "https://auth.example.com";
const registered: unknown[] = [];
const tokenBodies: URLSearchParams[] = [];

const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: MCP, authorization_servers: [AS] });
  if (url.origin === AS && url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
    });
  }
  if (url.origin === AS && url.pathname === "/register") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    registered.push(body);
    return json({ ...body, client_id: `client-${registered.length}` }, 201);
  }
  if (url.origin === AS && url.pathname === "/token") {
    tokenBodies.push(new URLSearchParams(String(init?.body)));
    return json({ access_token: "access-fixture", token_type: "Bearer", refresh_token: "refresh-fixture", expires_in: 3600 });
  }
  return new Response("not found", { status: 404 });
};

describe("signing a connector in", () => {
  it("registers itself, sends the person to the server's page with PKCE, and keys the tokens by issuer", async () => {
    const row = await db.createConnector({ name: "Example", transport: { type: "http", url: MCP } });
    const started = await startSignIn(row.id, MCP, fetchFn);
    if (!("authorizationUrl" in started)) throw new Error("expected a page to open");
    const page = new URL(started.authorizationUrl);
    expect(page.origin + page.pathname).toBe(`${AS}/authorize`);
    expect(page.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47999/connectors/oauth/callback");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(registered[0]).toMatchObject({ redirect_uris: [redirectUrl()], token_endpoint_auth_method: "none" });

    const done = await finishSignIn(new URLSearchParams({ code: "the-code", state: page.searchParams.get("state")!, iss: AS }), () => MCP, fetchFn);
    expect(done).toBe(row.id);
    expect(tokenBodies.at(-1)!.get("code_verifier")).toBeTruthy();
    expect(db.getConnectorOAuth(row.id, "tokens", AS)).toMatchObject({ access_token: "access-fixture", issuer: AS });
    expect(db.getConnectorOAuth(row.id, "client", AS)).toMatchObject({ client_id: "client-1" });
    for (const f of ["mcp.json", join("secrets", "connectors.json")]) expect(readFileSync(join(dir, f), "utf8")).not.toContain("access-fixture");
  });

  it("refuses a callback from an issuer other than the one the sign-in began with, and spends its state", async () => {
    const row = await db.createConnector({ name: "Mixed", transport: { type: "http", url: MCP } });
    const started = await startSignIn(row.id, MCP, fetchFn);
    if (!("authorizationUrl" in started)) throw new Error("expected a page to open");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(finishSignIn(new URLSearchParams({ code: "c", state, iss: "https://evil.example.com" }), () => MCP, fetchFn)).rejects.toThrow();
    expect(db.getConnectorOAuth(row.id, "tokens")).toBeUndefined();
    await expect(finishSignIn(new URLSearchParams({ code: "c", state, iss: AS }), () => MCP, fetchFn)).rejects.toThrow(/expired/);
  });

  it("uses a stored refresh token without sending anyone anywhere", async () => {
    const row = db.listConnectorRows().find((r) => r.name === "Example")!;
    const r = await startSignIn(row.id, MCP, fetchFn);
    expect(r).toEqual({ authorized: true });
    expect(tokenBodies.at(-1)!.get("grant_type")).toBe("refresh_token");
  });

  it("registers again when the redirect it registered with has moved to another port", async () => {
    const row = db.listConnectorRows().find((r) => r.name === "Example")!;
    expect(new ConnectorOAuth(row.id, redirectUrl()).clientInformation({ issuer: AS })).toMatchObject({ client_id: "client-1" });
    expect(new ConnectorOAuth(row.id, "http://127.0.0.1:1234/connectors/oauth/callback").clientInformation({ issuer: AS })).toBeUndefined();
  });

  it("forgets what the server says is no longer good", async () => {
    const row = db.listConnectorRows().find((r) => r.name === "Example")!;
    await new ConnectorOAuth(row.id, redirectUrl()).invalidateCredentials("tokens");
    expect(db.getConnectorOAuth(row.id, "tokens", AS)).toBeUndefined();
    expect(db.getConnectorOAuth(row.id, "client", AS)).toBeDefined();
  });
});
