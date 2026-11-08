import { handleNabdaApi } from "../lib/nabda-api";
import { configuredOrigins, handleIndependentAuth, readBrowserSession, type IndependentEnv } from "../lib/independent-auth";

const publicSections: Record<string, string> = {
  "/download": "setup", "/help": "questions", "/support": "support",
  "/privacy": "privacy", "/terms": "terms", "/docs": "api",
};
const topics: Record<string, string> = {
  installation: "setup", pairing: "setup", devices: "setup",
  quickstart: "request", messages: "request", "send-message": "request", testing: "request",
  authentication: "api", "phone-queue": "queue", queue: "queue", scheduling: "queue", cancellation: "queue",
  status: "results", events: "results", results: "results", limits: "limits", errors: "limits", usage: "limits",
};

function error(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}

function pageHeaders(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  return result;
}

const worker = {
  async fetch(original: Request, env: IndependentEnv): Promise<Response> {
    const url = new URL(original.url);
    // Keep liveness available while the owner is configuring new hosting.
    if (url.pathname === "/health") {
      return (await handleNabdaApi(original, env)) ?? error(404, "not_found", "This endpoint was not found.");
    }
    try {
      const origins = configuredOrigins(env);
      if (url.origin !== origins.api) return error(421, "origin_mismatch", "Use the configured Nabda API origin.");
      // Do not forward old platform identity headers into any application code.
      const requestHeaders = new Headers(original.headers);
      for (const name of [...requestHeaders.keys()]) if (name.toLowerCase().startsWith("oai-authenticated-")) requestHeaders.delete(name);
      const request = new Request(original, { headers: requestHeaders });
      const auth = await handleIndependentAuth(request, env);
      if (auth) return auth;
      const browserUser = url.pathname.startsWith("/api/") ? await readBrowserSession(request, env) : undefined;
      const api = await handleNabdaApi(request, env, browserUser);
      if (api) return api;
      if (request.method !== "GET" && request.method !== "HEAD") return error(405, "method_not_allowed", "Use GET to open this page.");
      if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
        if (!env.ASSETS) return error(503, "dashboard_unavailable", "Build the dashboard assets before deploying Nabda.");
        // This shell has no account data. Every management request independently
        // verifies its HttpOnly session; signed-out visitors see the sign-in UI.
        const assetUrl = new URL("/dashboard/index.html", origins.api);
        return pageHeaders(await env.ASSETS.fetch(new Request(assetUrl, { method: request.method })));
      }
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const section = publicSections[path] ?? (path.startsWith("/docs/") ? topics[path.split("/")[2]] ?? "api" : undefined);
      if (path === "/" || path === "/index.html" || section) {
        return new Response(null, { status: 308, headers: { Location: `${origins.website}/${section ? `#${section}` : ""}`, "Cache-Control": "public, max-age=300" } });
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return error(404, "not_found", "This page was not found.");
    } catch {
      // Config/DB failures must not disclose credentials, schema, or user data.
      return error(503, "service_unavailable", "The independent Nabda deployment is not ready yet. Check its hosting configuration and migrations.");
    }
  },
};

export default worker;
