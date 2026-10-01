import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, SdkError, SdkErrorCode, type CallToolResult, type ElicitRequestParams, type ElicitResult, type FetchLike, type Tool as McpTool, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectorSecrets, getConnectorRow, setConnectorTools, transportWire, type CachedTool, type ConnectorRow } from "@openlive/db";
import type { ConnectorStatus } from "@openlive/shared";
import type { Session } from "../capabilities/types.js";
import { log } from "../log.js";
import { ConnectorOAuth, redirectUrl } from "./oauth.js";
import { stdioParams } from "./spawn.js";

// The live side of connectors: one connection per connector, shared by every
// session in every mode, so a stdio server runs exactly once however many
// calls and Flow runs use it. Connections open on first use, a dropped one is
// reopened with backoff, and every child process is ended at shutdown.

/** A tool call may wait on a person (an elicitation) or a slow server; progress resets it. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_RECONNECTS = 6;
const backoffMs = (attempt: number) => Math.min(60_000, 1000 * 2 ** attempt);
/** Enough of a crashing server's stderr to say why. */
const STDERR_TAIL = 2000;

export interface ConnectorState { status: ConnectorStatus; error?: string }

/** A session making a call, so a server's question mid-call reaches the person who asked. */
type Caller = Pick<Session, "elicit" | "openUrl" | "device">;

/** `config`: what the connection was opened with (see configOf). */
interface Live { client: Client; close(): Promise<void>; config?: string }

/** Everything a connection is made from, secrets decrypted, so any change to it by hand shows. In memory only. */
const configOf = (row: ConnectorRow) => JSON.stringify([row.enabled, row.spawnConsent, transportWire(row.transport), connectorSecrets(row)]);

export class ConsentRequired extends Error {
  constructor(name: string) { super(`${name} has not been allowed to run yet. Allow it in Settings, Connectors.`); }
}
export class SignInRequired extends Error {
  constructor(name: string) { super(`${name} needs you to sign in. Sign in from Settings, Connectors.`); }
}

export class ConnectorManager {
  private live = new Map<string, Live>();
  private opening = new Map<string, Promise<Client>>();
  private state = new Map<string, ConnectorState>();
  private retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>();
  /** In-flight calls per connector, newest last. */
  private callers = new Map<string, Caller[]>();

  constructor(private readonly opts: { fetch?: FetchLike; version?: string } = {}) {}

  /** What the UI shows for a connector. Settings come first: an off or unconsented connector has no live state. */
  status(row: ConnectorRow): ConnectorState {
    if (!row.enabled) return { status: "disabled" };
    if (row.transport.type === "stdio" && !row.spawnConsent) return { status: "needs_consent" };
    return this.state.get(row.id) ?? { status: "disconnected" };
  }

  /** The open client, connecting on first use. Concurrent callers share one connect. */
  client(id: string): Promise<Client> {
    const live = this.live.get(id);
    if (live) return Promise.resolve(live.client);
    let opening = this.opening.get(id);
    if (!opening) {
      opening = this.open(id).finally(() => this.opening.delete(id));
      this.opening.set(id, opening);
    }
    return opening;
  }

  /**
   * Run one tool. The caller is remembered while the call runs, so a question
   * the server asks back lands with it. A connection that died between calls is
   * reopened once.
   */
  async call(id: string, tool: string, args: Record<string, unknown>, caller: Caller & { signal: AbortSignal }): Promise<CallToolResult> {
    const stack = this.callers.get(id) ?? [];
    stack.push(caller);
    this.callers.set(id, stack);
    const run = async () => (await this.client(id)).callTool({ name: tool, arguments: args }, { signal: caller.signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    try {
      try { return await run(); }
      catch (e) {
        if (!(e instanceof SdkError) || (e.code !== SdkErrorCode.ConnectionClosed && e.code !== SdkErrorCode.NotConnected)) throw e;
        await this.drop(id);
        return await run();
      }
    } finally {
      stack.splice(stack.indexOf(caller), 1);
    }
  }

  /** Close and reopen, forgetting any backoff. */
  async reconnect(id: string): Promise<Client> {
    await this.drop(id);
    this.retries.delete(id);
    return this.client(id);
  }

  /** Close a connector's connection and stop retrying it, for one switched off, edited or removed. */
  async disconnect(id: string): Promise<void> {
    clearTimeout(this.retries.get(id)?.timer);
    this.retries.delete(id);
    await this.drop(id);
    this.state.delete(id);
  }

  /** Every connection closed and every stdio child ended. */
  async shutdown(): Promise<void> {
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    await Promise.all([...this.live.keys()].map((id) => this.drop(id)));
  }

  /**
   * After mcp.json changed by hand: a connection whose connector is gone or was
   * opened from what is no longer written is closed, and opens again as written
   * on next use. One the app reopened itself already matches. O(connectors).
   */
  async reconcile(rows: ConnectorRow[]): Promise<void> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    await Promise.all([...this.live].map(([id, live]) => {
      const row = byId.get(id);
      return row && configOf(row) === live.config ? undefined : this.disconnect(id);
    }));
  }

  /**
   * Keep cached tool lists fresh without starting anything a session did not ask for:
   * a live connection past its list's ttlMs re-lists, and a connector never
   * listed connects once to learn its tools. O(connectors).
   */
  freshen(rows: ConnectorRow[]): void {
    const now = Date.now();
    for (const row of rows) {
      if (this.status(row).status !== "disconnected" && !this.live.has(row.id)) continue;
      if (!row.tools) { void this.client(row.id).catch(() => {}); continue; }
      const live = this.live.get(row.id);
      if (live && row.toolsTtlMs !== undefined && now - (row.toolsAt ?? 0) > row.toolsTtlMs) void this.list(row.id, live.client).catch(() => {});
    }
  }

  private set(id: string, s: ConnectorState): void { this.state.set(id, s); }

  private async drop(id: string): Promise<void> {
    const live = this.live.get(id);
    this.live.delete(id);
    if (live) await live.close().catch(() => {});
    if (this.state.get(id)?.status === "connected") this.set(id, { status: "disconnected" });
  }

  private async open(id: string): Promise<Client> {
    const row = getConnectorRow(id);
    if (!row) throw new Error("That connector was removed.");
    if (!row.enabled) throw new Error(`${row.name} is switched off.`);
    if (row.transport.type === "stdio" && !row.spawnConsent) throw new ConsentRequired(row.name);
    this.set(id, { status: "connecting" });
    try {
      const live = row.transport.type === "stdio" ? await this.openStdio(row) : await this.openHttp(row);
      live.config = configOf(row);
      live.client.onclose = () => {
        if (this.live.get(id)?.client !== live.client) return; // we closed it ourselves
        this.live.delete(id);
        this.set(id, { status: "disconnected" });
        this.retry(id);
      };
      this.live.set(id, live);
      this.retries.delete(id);
      this.set(id, { status: "connected" });
      await this.list(id, live.client);
      return live.client;
    } catch (e) {
      const needsAuth = e instanceof UnauthorizedError || (e instanceof SdkError && e.code === SdkErrorCode.ClientHttpAuthentication);
      this.set(id, needsAuth ? { status: "needs_auth" } : { status: "error", error: errText(e) });
      throw needsAuth ? new SignInRequired(row.name) : e;
    }
  }

  private retry(id: string): void {
    const r = this.retries.get(id) ?? { attempt: 0 };
    if (r.attempt >= MAX_RECONNECTS) {
      this.set(id, { status: "error", error: `Stopped after ${MAX_RECONNECTS} failed reconnects.` });
      return;
    }
    r.timer = setTimeout(() => {
      r.attempt++;
      const row = getConnectorRow(id);
      // Off, unconsented or waiting on a sign-in: retrying cannot help until the person acts.
      const s = row && this.status(row).status;
      if (!s || s === "disabled" || s === "needs_consent" || s === "needs_auth" || this.live.has(id)) return;
      this.client(id).catch(() => this.retry(id));
    }, backoffMs(r.attempt));
    r.timer.unref();
    this.retries.set(id, r);
  }

  private newClient(id: string): Client {
    const client = new Client(
      { name: "openlive", version: this.opts.version ?? "1" },
      {
        capabilities: { elicitation: { form: {}, url: {} } },
        listChanged: { tools: { onChanged: (err, tools) => { if (!err && tools) void this.store(id, tools); } } },
      },
    );
    client.setRequestHandler("elicitation/create", (req) => this.elicit(id, req.params));
    return client;
  }

  private async openStdio(row: ConnectorRow): Promise<Live> {
    if (row.transport.type !== "stdio") throw new Error("not stdio");
    const transport = new StdioClientTransport({ ...stdioParams(row.transport, connectorSecrets(row)), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL); });
    const client = this.newClient(row.id);
    try {
      // 2025 handshake: the 2026 probe on stdio starts a second copy of the server just to ask.
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (e) {
      await transport.close().catch(() => {});
      throw new Error(stderr.trim() ? `${errText(e)}: ${stderr.trim().split("\n").slice(-3).join(" ")}` : errText(e));
    }
    return { client, close: () => client.close() };
  }

  /**
   * Streamable HTTP, negotiating the 2026-07-28 era where the server offers it.
   * A server whose probe fails outright is asked again the 2025 way, and one
   * that only speaks the older SSE transport is reached over that.
   */
  private async openHttp(row: ConnectorRow): Promise<Live> {
    if (row.transport.type !== "http") throw new Error("not http");
    const url = new URL(row.transport.url);
    const requestInit = { headers: connectorSecrets(row) };
    const authProvider = new ConnectorOAuth(row.id, redirectUrl());
    const attempt = async (make: () => Transport, mode: "auto" | "legacy"): Promise<Live> => {
      const client = this.newClient(row.id);
      client.setVersionNegotiation({ mode });
      await client.connect(make(), { timeout: CONNECT_TIMEOUT_MS });
      return { client, close: () => client.close() };
    };
    const streamable = () => new StreamableHTTPClientTransport(url, { authProvider, requestInit, fetch: this.opts.fetch });
    try {
      return await attempt(streamable, "auto");
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      if (e instanceof SdkError && e.code === SdkErrorCode.EraNegotiationFailed) {
        try { return await attempt(streamable, "legacy"); } catch { /* fall through to SSE */ }
      }
      try {
        return await attempt(() => new SSEClientTransport(url, { authProvider, requestInit, fetch: this.opts.fetch }), "legacy");
      } catch (sse) {
        if (sse instanceof UnauthorizedError) throw sse;
        throw e;
      }
    }
  }

  private async list(id: string, client: Client): Promise<void> {
    const r = await client.listTools(undefined, { cacheMode: "refresh" });
    // 2026-07-28 lets a list say how long it stays fresh.
    const ttl = (r as { ttlMs?: unknown }).ttlMs;
    await this.store(id, r.tools, typeof ttl === "number" && ttl > 0 ? ttl : undefined);
  }

  private async store(id: string, tools: McpTool[], ttlMs?: number): Promise<void> {
    const cached: CachedTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
      readOnly: t.annotations?.readOnlyHint === true,
    }));
    await setConnectorTools(id, cached, ttlMs);
  }

  /**
   * A server asks the person something mid-call. It goes to the newest call
   * running on that connector: one connection serves every session, and the
   * request carries nothing that names the call it belongs to. A page to visit
   * opens in the browser; a form needs a session that can show one (a call),
   * and is declined everywhere else.
   */
  private async elicit(id: string, params: ElicitRequestParams): Promise<ElicitResult> {
    const caller = this.callers.get(id)?.at(-1);
    if (!caller) return { action: "decline" };
    if (caller.elicit) {
      const url = params.mode === "url";
      const answer = await caller.elicit({
        mode: url ? "url" : "form",
        message: params.message,
        ...(url ? { url: params.url, elicitationId: params.elicitationId } : { schema: params.requestedSchema }),
      });
      return answer.action === "accept" ? { action: "accept", ...(answer.content && { content: answer.content as ElicitResult["content"] }) } : { action: answer.action };
    }
    if (params.mode !== "url") return { action: "decline" };
    try {
      if (caller.device) await caller.device.control({ kind: "open_url", url: params.url });
      else if (caller.openUrl) await caller.openUrl(params.url);
      else return { action: "decline" };
      return { action: "accept" };
    } catch (e) {
      log.warn("connectors", "elicitation url:", e);
      return { action: "cancel" };
    }
  }
}

export const errText = (e: unknown): string => ((e instanceof Error ? e.message : String(e)) || "it failed").slice(0, 400);

/** The one manager the server runs. */
export const connectors = new ConnectorManager();
