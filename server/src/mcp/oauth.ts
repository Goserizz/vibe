import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import type { McpOAuthStatus } from '../../../shared/protocol.js';

/**
 * Standard MCP-OAuth client (RFC 9728 protected-resource metadata → RFC 8414
 * authorization-server metadata → RFC 7591 dynamic client registration → OAuth
 * 2.1 authorization-code + PKCE).
 *
 * Vibe runs the whole dance once per server when the user clicks "Connect",
 * persists the tokens + registered client to ~/.vibe/mcp-oauth.json (0600), and
 * refreshes them on a background timer. The current access token is then stamped
 * as `Authorization: Bearer …` into every engine's MCP config (see apply.ts), so
 * Claude, Cursor, and Codex — not just Claude — reach OAuth-gated remote servers like the
 * Notion MCP.
 *
 * The redirect_uri is a route on this Vibe server (`${origin}/api/mcp/oauth/
 * callback`), reached by the user's browser after consent. That works for a
 * locally-run Vibe (loopback origin) and for a remote Vibe as long as the
 * authorization server accepts the dynamically-registered redirect URI (the DCR
 * flow registers it, so most servers do; a few enforce loopback-only).
 */

const PENDING_TTL_MS = 10 * 60_000;
/** Refresh a token once this much lifetime remains. */
const REFRESH_WINDOW_MS = 15 * 60_000;

interface Endpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
}

interface OAuthRecord extends Endpoints {
  serverName: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  scope?: string;
}

interface PendingFlow {
  serverName: string;
  endpoints: Endpoints;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
}

interface OAuthFile {
  records: Record<string, OAuthRecord>;
}

// ---- crypto helpers ---------------------------------------------------------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function pkceVerifier(): string {
  // 32 random bytes → base64url (~43 chars, within the 43–128 range).
  return b64url(crypto.randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

function randToken(): string {
  return b64url(crypto.randomBytes(32));
}

// ---- HTTP helpers -----------------------------------------------------------

async function getJson(url: string, opts: RequestInit = {}, bearer?: string): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers as Record<string, string> | undefined) };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${url} → non-JSON: ${text.slice(0, 300)}`);
  }
}

async function postForm(url: string, body: Record<string, string | undefined>): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v != null) form.set(k, v);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`POST ${url} → non-JSON: ${text.slice(0, 300)}`);
  }
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/** Parse `WWW-Authenticate: Bearer … resource_metadata="URL"` (RFC 9728). */
function parseResourceMetadataUrl(wwwAuth: string | null | undefined): string | undefined {
  if (!wwwAuth) return undefined;
  const m = wwwAuth.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  return m?.[1];
}

// ---- discovery --------------------------------------------------------------

/** Resolve the OAuth endpoints for an MCP resource URL. */
export async function discover(resourceUrl: string): Promise<{ endpoints: Endpoints; resourceMetadataUrl: string }> {
  // Step 1: probe the resource. A 401 carries the protected-resource metadata URL.
  let prmUrl: string | undefined;
  try {
    const probe = await fetch(resourceUrl, { headers: { Accept: 'application/json' } });
    if (probe.status === 401) {
      prmUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate'));
    }
  } catch {
    /* fall through to default location */
  }
  // Default location per RFC 9728 (origin + /.well-known/oauth-protected-resource).
  if (!prmUrl) prmUrl = `${originOf(resourceUrl).replace(/\/$/, '')}/.well-known/oauth-protected-resource`;

  // Step 2: fetch the protected-resource metadata → authorization_servers.
  let prm: any;
  try {
    prm = await getJson(prmUrl);
  } catch (err) {
    throw new Error(`MCP resource has no OAuth metadata at ${prmUrl}: ${(err as Error).message}`);
  }
  const asUrls: string[] = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : [];
  if (!asUrls.length) throw new Error('OAuth resource metadata lists no authorization_servers');

  // Step 3: each entry is (or points at) an RFC 8414 authorization-server metadata doc.
  let endpoints: Endpoints | undefined;
  let lastErr: unknown;
  for (const raw of asUrls) {
    const candidates = [raw, `${originOf(raw).replace(/\/$/, '')}/.well-known/oauth-authorization-server`];
    for (const url of candidates) {
      try {
        const md = await getJson(url);
        if (md.authorization_endpoint && md.token_endpoint) {
          endpoints = {
            authorizationEndpoint: md.authorization_endpoint,
            tokenEndpoint: md.token_endpoint,
            registrationEndpoint: md.registration_endpoint,
            revocationEndpoint: md.revocation_endpoint,
            scopesSupported: Array.isArray(md.scopes_supported) ? md.scopes_supported : undefined,
          };
          break;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    if (endpoints) break;
  }
  if (!endpoints) throw new Error(`could not resolve OAuth authorization-server metadata: ${(lastErr as Error)?.message ?? 'unknown'}`);
  return { endpoints, resourceMetadataUrl: prmUrl };
}

async function dynamicRegister(registrationEndpoint: string, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  const body = {
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_name: 'Vibe',
    application_type: 'web',
  };
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`dynamic client registration failed (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!data.client_id) throw new Error(`DCR response missing client_id: ${text.slice(0, 200)}`);
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

// ---- store ------------------------------------------------------------------

class OAuthStore {
  private records = new Map<string, OAuthRecord>();
  private pending = new Map<string, PendingFlow>();
  private timer?: NodeJS.Timeout;

  constructor() {
    this.load();
    // Refresh tokens nearing expiry on a background tick so apply paths (which
    // read the access token synchronously) always see a live token.
    this.timer = setInterval(() => void this.refreshExpiring(), 5 * 60_000);
    this.timer.unref?.();
    void this.refreshExpiring();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.mcpOauthFile, 'utf8')) as OAuthFile;
      if (parsed?.records) {
        for (const [name, rec] of Object.entries(parsed.records)) if (rec?.accessToken) this.records.set(name, { ...rec, serverName: name });
      }
    } catch {
      /* first run */
    }
  }

  private save(): void {
    try {
      const tmp = `${config.mcpOauthFile}.tmp`;
      const data: OAuthFile = { records: Object.fromEntries(this.records) };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, config.mcpOauthFile);
      // Ensure 0600 even if the file pre-existed with looser perms.
      try {
        fs.chmodSync(config.mcpOauthFile, 0o600);
      } catch {
        /* ignore */
      }
    } catch (err) {
      log.error('failed to persist mcp oauth tokens', err);
    }
  }

  has(name: string): boolean {
    return this.records.has(name);
  }

  status(name: string): McpOAuthStatus {
    const rec = this.records.get(name);
    if (!rec) return { connected: false };
    return { connected: Boolean(rec.accessToken), expiresAt: rec.expiresAt };
  }

  snapshotStatus(): Record<string, McpOAuthStatus> {
    const out: Record<string, McpOAuthStatus> = {};
    for (const name of this.records.keys()) out[name] = this.status(name);
    return out;
  }

  /** Current bearer token (sync; refreshed proactively by the background timer). */
  bearerFor(name: string): string | undefined {
    return this.records.get(name)?.accessToken;
  }

  /** Refresh now if the token is within its refresh window. */
  async ensureFresh(name: string): Promise<void> {
    const rec = this.records.get(name);
    if (!rec?.refreshToken) return;
    if (rec.expiresAt - REFRESH_WINDOW_MS > Date.now()) return;
    await this.doRefresh(rec);
  }

  /** Begin the flow: discover + register + build the consent URL. */
  async startAuth(serverName: string, resourceUrl: string, redirectUri: string): Promise<string> {
    const { endpoints } = await discover(resourceUrl);
    let clientId: string;
    let clientSecret: string | undefined;
    if (endpoints.registrationEndpoint) {
      const reg = await dynamicRegister(endpoints.registrationEndpoint, redirectUri);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    } else {
      // No DCR: fall back to the conventional MCP public client id.
      clientId = 'OAUTH_CLIENT_ID';
    }

    const codeVerifier = pkceVerifier();
    const state = randToken();
    this.pending.set(state, { serverName, endpoints, clientId, clientSecret, redirectUri, codeVerifier, createdAt: Date.now() });
    this.sweepPending();

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
    });
    return `${endpoints.authorizationEndpoint}?${params.toString()}`;
  }

  /** Complete the flow at the callback: exchange the code for tokens. */
  async handleCallback(state: string, code: string): Promise<string> {
    const p = this.pending.get(state);
    if (!p) throw new Error('invalid or expired OAuth state');
    this.pending.delete(state);
    const token = await postForm(p.endpoints.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: p.codeVerifier,
    });
    if (!token.access_token) throw new Error(`token endpoint returned no access_token: ${JSON.stringify(token).slice(0, 300)}`);
    this.putRecord(p, token);
    return p.serverName;
  }

  private putRecord(p: PendingFlow, token: any): void {
    const rec: OAuthRecord = {
      serverName: p.serverName,
      ...p.endpoints,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      redirectUri: p.redirectUri,
      accessToken: token.access_token,
      tokenType: token.token_type,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      scope: token.scope,
    };
    this.records.set(p.serverName, rec);
    this.save();
  }

  private async doRefresh(rec: OAuthRecord): Promise<void> {
    if (!rec.refreshToken) return;
    try {
      const token = await postForm(rec.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: rec.refreshToken,
        client_id: rec.clientId,
        client_secret: rec.clientSecret,
      });
      if (!token.access_token) throw new Error('no access_token in refresh response');
      rec.accessToken = token.access_token;
      rec.tokenType = token.token_type ?? rec.tokenType;
      if (token.refresh_token) rec.refreshToken = token.refresh_token;
      rec.expiresAt = Date.now() + (Number(token.expires_in) || 3600) * 1000;
      rec.scope = token.scope ?? rec.scope;
      this.save();
    } catch (err) {
      log.warn(`oauth refresh failed for ${rec.serverName}`, err);
    }
  }

  private async refreshExpiring(): Promise<void> {
    const due = [...this.records.values()].filter((r) => r.refreshToken && r.expiresAt - REFRESH_WINDOW_MS <= Date.now());
    await Promise.all(due.map((r) => this.doRefresh(r)));
  }

  private sweepPending(): void {
    const now = Date.now();
    for (const [k, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  /** Revoke (best-effort) + drop tokens for a server. */
  async disconnect(name: string): Promise<void> {
    const rec = this.records.get(name);
    if (rec?.revocationEndpoint && rec.accessToken) {
      try {
        await postForm(rec.revocationEndpoint, { token: rec.accessToken, client_id: rec.clientId, token_type_hint: 'access_token' });
      } catch {
        /* best-effort */
      }
    }
    this.records.delete(name);
    this.save();
  }
}

export const oauthStore = new OAuthStore();
