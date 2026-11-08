import { digest, type BrowserUser } from "./nabda-api";

/** Only the independently deployed Worker uses this environment. */
export type IndependentEnv = {
  DB?: D1Database;
  ASSETS?: Fetcher;
  API_ORIGIN?: string;
  WEBSITE_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

type AuthDependencies = { fetch?: typeof fetch };
type Origins = { api: string; website: string };
type Attempt = { verifier: string; return_to: string };
const SESSION_COOKIE = "__Host-nabda_session";
const ATTEMPT_COOKIE = "__Host-nabda_oauth";
const ATTEMPT_SECONDS = 600;
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function origin(value: string | undefined): string {
  try {
    const url = new URL(value || "");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        url.hostname.endsWith(".invalid")) throw new Error();
    return url.origin;
  } catch {
    throw new AuthError(503, "hosting_not_configured", "Configure the independent API and website origins before using this deployment.");
  }
}

export function configuredOrigins(env: IndependentEnv): Origins {
  const api = origin(env.API_ORIGIN);
  const website = origin(env.WEBSITE_ORIGIN);
  if (api === website) throw new AuthError(503, "hosting_not_configured", "The independent API and website must use different origins.");
  return { api, website };
}

function githubConfiguration(env: IndependentEnv): { clientId: string; clientSecret: string } {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || clientId.length > 200 || clientSecret.length > 500 ||
      /\s/.test(clientId) || /\s/.test(clientSecret)) {
    throw new AuthError(503, "sign_in_not_configured", "GitHub sign-in has not been configured for this deployment yet.");
  }
  return { clientId, clientSecret };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }

function cookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") || "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : undefined;
}

function setCookie(name: string, value: string, seconds: number): string {
  // Host-only: never add Domain or weaken Secure for local development.
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string { return setCookie(name, "", 0); }

function headers(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const result = headers();
  result.set("Location", location);
  for (const value of cookies) result.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers: result });
}

function failure(error: unknown, clearAttempt = false, allow?: string): Response {
  const known = error instanceof AuthError;
  const result = headers();
  result.set("Content-Type", "application/json; charset=utf-8");
  if (known && error.status === 405 && allow) result.set("Allow", allow);
  if (clearAttempt) result.append("Set-Cookie", clearCookie(ATTEMPT_COOKIE));
  return new Response(JSON.stringify({ error: {
    code: known ? error.code : "sign_in_unavailable",
    message: known ? error.message : "Sign-in could not complete. Start again from your Nabda dashboard.",
  } }), { status: known ? error.status : 503, headers: result });
}

function requireDatabase(env: IndependentEnv): D1Database {
  if (!env.DB) throw new AuthError(503, "database_unavailable", "Nabda's account database is not available yet.");
  return env.DB;
}

function requireApiOrigin(request: Request, origins: Origins): void {
  if (new URL(request.url).origin !== origins.api) {
    throw new AuthError(421, "origin_mismatch", "Open the configured Nabda API origin to sign in.");
  }
}

function oneParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

async function cleanupExpired(db: D1Database, now: string): Promise<void> {
  // Bounded maintenance, on sign-in only. Reading a session never writes a row.
  await db.batch([
    db.prepare("DELETE FROM oauth_attempts WHERE state_hash IN (SELECT state_hash FROM oauth_attempts WHERE expires_at<=? LIMIT 100)").bind(now),
    db.prepare("DELETE FROM browser_sessions WHERE token_hash IN (SELECT token_hash FROM browser_sessions WHERE expires_at<=? LIMIT 100)").bind(now),
  ]);
}

async function beginSignIn(request: Request, env: IndependentEnv, origins: Origins): Promise<Response> {
  const db = requireDatabase(env);
  const { clientId } = githubConfiguration(env);
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ATTEMPT_SECONDS * 1_000).toISOString();
  await cleanupExpired(db, now);
  const currentAttempt = cookie(request, ATTEMPT_COOKIE);
  if (currentAttempt) {
    // Starting over invalidates this browser's earlier unfinished attempt.
    await db.prepare("DELETE FROM oauth_attempts WHERE browser_hash=?").bind(await digest(currentAttempt)).run();
  }
  const inserted = await db.prepare("INSERT INTO oauth_attempts(state_hash,browser_hash,verifier,return_to,created_at,expires_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_attempts WHERE expires_at>?)<1000")
    .bind(await digest(state), await digest(browser), verifier, "/dashboard", now, expiresAt, now).run();
  if (!inserted.meta.changes) throw new AuthError(429, "sign_in_busy", "Sign-in is busy. Please try again in a few minutes.");
  const authorization = new URL("https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", `${origins.api}/auth/github/callback`);
  authorization.searchParams.set("scope", "read:user user:email");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)))));
  authorization.searchParams.set("code_challenge_method", "S256");
  return redirect(authorization.toString(), [setCookie(ATTEMPT_COOKIE, browser, ATTEMPT_SECONDS)]);
}

async function githubJson(fetcher: typeof fetch, url: string, options: RequestInit, maxBytes = 65_536): Promise<unknown> {
  // Workers supports follow/manual, not the Fetch standard's error mode.
  // Return redirects unchanged and reject them through response.ok below so a
  // provider redirect cannot forward the OAuth secret or Authorization header.
  const response = await fetcher(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new AuthError(502, "github_unavailable", "GitHub could not verify this sign-in. Please start again.");
  // Bound even a malformed upstream response before JSON parsing.
  const reader = response.body?.getReader();
  if (!reader) throw new AuthError(502, "github_unavailable", "GitHub returned an incomplete sign-in response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new AuthError(502, "github_unavailable", "GitHub returned an unexpected sign-in response.");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AuthError(502, "github_unavailable", "GitHub returned an unexpected sign-in response."); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError(502, "github_unavailable", "GitHub returned an unexpected sign-in response.");
  }
  return value as Record<string, unknown>;
}

async function completeSignIn(request: Request, env: IndependentEnv, origins: Origins, fetcher: typeof fetch): Promise<Response> {
  const db = requireDatabase(env);
  const { clientId, clientSecret } = githubConfiguration(env);
  const url = new URL(request.url);
  const state = oneParameter(url, "state");
  const browser = cookie(request, ATTEMPT_COOKIE);
  if (!state || !TOKEN_PATTERN.test(state) || !browser) {
    throw new AuthError(400, "invalid_sign_in", "This sign-in request is invalid or expired. Start again from the dashboard.");
  }
  const now = new Date().toISOString();
  // Atomically consume only the matching, unexpired browser-bound attempt.
  // Two callbacks cannot redeem one OAuth attempt, even if they race.
  const attempt = await db.prepare("DELETE FROM oauth_attempts WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING verifier,return_to")
    .bind(await digest(state), await digest(browser), now).first<Attempt>();
  if (!attempt) throw new AuthError(400, "invalid_sign_in", "This sign-in request is invalid or expired. Start again from the dashboard.");
  if (url.searchParams.has("error")) throw new AuthError(400, "sign_in_cancelled", "GitHub sign-in was cancelled. You can start again whenever you like.");
  const code = oneParameter(url, "code");
  if (!code || code.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new AuthError(400, "invalid_sign_in", "GitHub did not return a valid authorization code. Start again.");
  }
  const token = record(await githubJson(fetcher, "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Nabda/0.2.0" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${origins.api}/auth/github/callback`, code_verifier: attempt.verifier }).toString(),
  }));
  const accessToken = token.access_token;
  const scopes = typeof token.scope === "string" ? token.scope.split(/[\s,]+/) : [];
  if (typeof accessToken !== "string" || accessToken.length < 10 || accessToken.length > 1_024 || /\s/.test(accessToken) || token.token_type !== "bearer" ||
      !(scopes.includes("user:email") || scopes.includes("user")) || !(scopes.includes("read:user") || scopes.includes("user"))) {
    throw new AuthError(403, "github_permission_required", "Allow access to a verified GitHub email address to create your Nabda workspace.");
  }
  const apiHeaders = {
    "Accept": "application/vnd.github+json", "Authorization": `Bearer ${accessToken}`,
    "User-Agent": "Nabda/0.2.0", "X-GitHub-Api-Version": "2026-03-10",
  };
  const profile = record(await githubJson(fetcher, "https://api.github.com/user", { headers: apiHeaders }));
  const emails = await githubJson(fetcher, "https://api.github.com/user/emails?per_page=100", { headers: apiHeaders });
  if (!Number.isSafeInteger(profile.id) || Number(profile.id) <= 0 || typeof profile.login !== "string" || profile.login.length > 100 || !Array.isArray(emails)) {
    throw new AuthError(502, "github_unavailable", "GitHub returned an unexpected account response.");
  }
  const verified = emails.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.verified === true && typeof item.email === "string" && item.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email));
  const selected = verified.find((item) => item.primary === true) ?? verified[0];
  if (!selected) throw new AuthError(403, "verified_email_required", "Verify an email address in GitHub, then sign in to Nabda again.");
  const userId = `github:${profile.id}`;
  const email = String(selected.email);
  const name = (typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : profile.login).slice(0, 120);
  const session = randomToken();
  const sessionExpires = new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString();
  const previousSession = cookie(request, SESSION_COOKIE);
  const previousHash = previousSession ? await digest(previousSession) : "";
  await db.batch([
    db.prepare("INSERT INTO independent_users(id,github_id,email,name,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,updated_at=excluded.updated_at")
      .bind(userId, String(profile.id), email, name, now, now),
    db.prepare("DELETE FROM browser_sessions WHERE token_hash=?").bind(previousHash),
    db.prepare("INSERT INTO browser_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(await digest(session), userId, now, sessionExpires),
    // Retain a bounded number of recent sessions per account. New logins rotate
    // the browser credential, and old copies do not create unlimited rows.
    db.prepare("DELETE FROM browser_sessions WHERE user_id=? AND token_hash<>? AND token_hash NOT IN (SELECT token_hash FROM browser_sessions WHERE user_id=? AND token_hash<>? ORDER BY created_at DESC,token_hash DESC LIMIT 9)")
      .bind(userId, await digest(session), userId, await digest(session)),
  ]);
  // The GitHub access token is only used above and is never written to D1,
  // sent to the browser, or retained as a Nabda credential.
  return redirect(`${origins.api}${attempt.return_to === "/dashboard" ? attempt.return_to : "/dashboard"}`, [
    clearCookie(ATTEMPT_COOKIE), setCookie(SESSION_COOKIE, session, SESSION_SECONDS),
  ]);
}

export async function readBrowserSession(request: Request, env: IndependentEnv): Promise<BrowserUser | undefined> {
  const value = cookie(request, SESSION_COOKIE);
  if (!value || !env.DB) return undefined;
  const row = await env.DB.prepare("SELECT u.id,u.email,u.name FROM browser_sessions s JOIN independent_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?")
    .bind(await digest(value), new Date().toISOString()).first<BrowserUser>();
  return row ?? undefined;
}

async function signOut(request: Request, env: IndependentEnv, origins: Origins): Promise<Response> {
  if (request.headers.get("origin") !== origins.api || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthError(403, "origin_rejected", "Sign out from your Nabda dashboard.");
  }
  const db = requireDatabase(env);
  const value = cookie(request, SESSION_COOKIE);
  const attempt = cookie(request, ATTEMPT_COOKIE);
  const operations = [];
  if (value) operations.push(db.prepare("DELETE FROM browser_sessions WHERE token_hash=?").bind(await digest(value)));
  if (attempt) operations.push(db.prepare("DELETE FROM oauth_attempts WHERE browser_hash=?").bind(await digest(attempt)));
  if (operations.length) await db.batch(operations);
  return redirect(`${origins.api}/dashboard`, [clearCookie(SESSION_COOKIE), clearCookie(ATTEMPT_COOKIE)]);
}

/** A fetch seam supports deterministic provider tests; no test login exists. */
export async function handleIndependentAuth(request: Request, env: IndependentEnv, dependencies: AuthDependencies = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const route = url.pathname;
  if (!route.startsWith("/auth/")) return null;
  try {
    const origins = configuredOrigins(env);
    requireApiOrigin(request, origins);
    if (route === "/auth/github" && request.method === "GET") return await beginSignIn(request, env, origins);
    if (route === "/auth/github/callback" && request.method === "GET") return await completeSignIn(request, env, origins, dependencies.fetch ?? fetch);
    if (route === "/auth/logout" && request.method === "POST") return await signOut(request, env, origins);
    const known = ["/auth/github", "/auth/github/callback", "/auth/logout"].includes(route);
    throw new AuthError(known ? 405 : 404, known ? "method_not_allowed" : "not_found", "This authentication route is not available for this request.");
  } catch (error) { return failure(error, route === "/auth/github/callback", route === "/auth/logout" ? "POST" : "GET"); }
}
