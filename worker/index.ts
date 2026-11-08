/// <reference types="vite/client" />

import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { handleNabdaApi, type BrowserUser } from "../lib/nabda-api";
import storyHtml from "../content/story.html?raw";

const publicSections: Record<string, string> = {
  "/how-it-works": "idea",
  "/download": "setup",
  "/help": "questions",
  "/support": "support",
  "/privacy": "privacy",
  "/terms": "terms",
  "/docs": "api",
};

const documentationSections: Record<string, string> = {
  installation: "setup",
  pairing: "setup",
  devices: "setup",
  quickstart: "request",
  messages: "request",
  "send-message": "request",
  testing: "request",
  authentication: "api",
  "phone-queue": "queue",
  queue: "queue",
  scheduling: "queue",
  cancellation: "queue",
  status: "results",
  events: "results",
  results: "results",
  limits: "limits",
  errors: "limits",
  usage: "limits",
};

// This adapter is exclusive to the existing Sites deployment. Sites dispatch
// strips caller headers and supplies this identity after authenticating a
// visitor. The independently deployed worker never imports this adapter.
function sitesBrowserUser(request: Request): BrowserUser | undefined {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (!id || !email) return undefined;
  let name = request.headers.get("oai-authenticated-user-full-name") || email.split("@")[0];
  if (request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { name = decodeURIComponent(name); } catch { /* Display only. */ }
  }
  return { id, email, name: name.slice(0, 120) };
}

function publicPage(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return new Response(request.method === "HEAD" ? null : storyHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") return;
  if (url.pathname === "/index.html") {
    return Response.redirect(new URL("/", url).toString(), 308);
  }
  const path = url.pathname.replace(/\/+$/, "");
  const section = publicSections[path]
    ?? (path.startsWith("/docs/") ? documentationSections[path.split("/")[2]] ?? "api" : undefined);
  if (section) {
    return Response.redirect(new URL(`/#${section}`, url).toString(), 308);
  }
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const response = await handleNabdaApi(request, env, sitesBrowserUser(request));
    if (response) return response;
    const page = publicPage(request);
    if (page) return page;
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};

export default worker;
