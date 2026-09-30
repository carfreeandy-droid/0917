import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { MurekaEnv } from "./generation";

const PUBLIC_ORIGIN = "https://how-mureka-mcp.how-mureka-mcp.workers.dev";
const CALLBACK_URL = `${PUBLIC_ORIGIN}/callback`;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const SUPPORTED_SCOPES = new Set(["mureka:read", "mureka:prepare", "mureka:execute"]);
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024;

export type GitHubAuthProps = { githubUserId: string };
export type OAuthEnv = MurekaEnv & {
  MUREKA_OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  ALLOWED_GITHUB_USER_ID?: string;
  OAUTH_PROVIDER: OAuthHelpers;
};

// The Cloudflare provider library conventionally reads `OAUTH_KV`. Keep the
// deployed binding named for this service and add this in-memory alias at the
// Worker boundary, so only one KV namespace is provisioned.
export type OAuthProviderEnv = OAuthEnv & { OAUTH_KV: KVNamespace };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
}

function securityHeaders(headers = new Headers()): Headers {
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return headers;
}

function html(body: string, headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers: securityHeaders(headers) });
}

function errorPage(status: number, message: string): Response {
  return html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>HOW Mureka MCP</title><body><h1>HOW Mureka MCP</h1><p>${escapeHtml(message)}</p></body></html>`, new Headers(), status);
}

function redirect(headers: Headers, location: string): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers: securityHeaders(headers) });
}

function configurationProblem(env: OAuthEnv): string | null {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.COOKIE_ENCRYPTION_KEY || !env.ALLOWED_GITHUB_USER_ID) {
    return "OAuth is not configured yet.";
  }
  if (env.COOKIE_ENCRYPTION_KEY.length < 32) {
    return "OAuth cookie configuration is invalid.";
  }
  return null;
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError) || !error.redirectUri) return errorPage(400, "OAuth authorization request was rejected.");
  const destination = new URL(error.redirectUri);
  destination.searchParams.set("error", error.code);
  destination.searchParams.set("error_description", error.description);
  if (error.state) destination.searchParams.set("state", error.state);
  if (error.issuer) destination.searchParams.set("iss", error.issuer);
  return Response.redirect(destination.href, 302);
}

function scopesToGrant(request: AuthRequest): string[] {
  const requested = request.scope.filter((scope) => SUPPORTED_SCOPES.has(scope));
  // MCP clients are allowed to omit `scope`; a private server still needs a
  // safe baseline so discovery and read-only status checks can work.
  return requested.length > 0 ? requested : ["mureka:read"];
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub response is too large.");
  const text = await response.text();
  if (text.length > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub response is too large.");
  try { return JSON.parse(text); } catch { throw new Error("GitHub returned an invalid response."); }
}

async function exchangeGithubCode(env: OAuthEnv, code: string): Promise<string> {
  const form = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID ?? "", client_secret: env.GITHUB_CLIENT_SECRET ?? "", code, redirect_uri: CALLBACK_URL });
  const response = await fetch(GITHUB_TOKEN_URL, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "HOW-Mureka-MCP" }, body: form });
  const body = await readBoundedJson(response);
  if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).access_token !== "string") throw new Error("GitHub authentication could not be completed.");
  return (body as Record<string, unknown>).access_token as string;
}

async function getGithubNumericUserId(accessToken: string): Promise<string> {
  const response = await fetch(GITHUB_USER_URL, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "User-Agent": "HOW-Mureka-MCP", "X-GitHub-Api-Version": "2022-11-28" } });
  const body = await readBoundedJson(response);
  if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body) || !Number.isSafeInteger((body as Record<string, unknown>).id)) throw new Error("GitHub identity could not be verified.");
  return String((body as Record<string, unknown>).id);
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const normalizedRight = new Uint8Array(leftBytes.length);
  normalizedRight.set(rightBytes.subarray(0, leftBytes.length));
  const leftHash = new Uint8Array(await crypto.subtle.digest("SHA-256", leftBytes));
  const rightHash = new Uint8Array(await crypto.subtle.digest("SHA-256", normalizedRight));
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash[index] ^ rightHash[index];
  return difference === 0;
}

async function beginGithubAuthorization(env: OAuthEnv, request: AuthRequest, headers: Headers): Promise<Response> {
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(request, { headers });
  const target = new URL(GITHUB_AUTHORIZE_URL);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID ?? "");
  target.searchParams.set("redirect_uri", CALLBACK_URL);
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("state", upstream.state);
  return redirect(upstream.headers, target.href);
}

async function showConsent(request: Request, env: OAuthEnv): Promise<Response> {
  let authorization: AuthRequest;
  try { authorization = await env.OAUTH_PROVIDER.parseAuthRequest(request); } catch (error) { return authorizationErrorResponse(error); }
  const problem = configurationProblem(env);
  if (problem) return errorPage(503, problem);
  try {
    if (await env.OAUTH_PROVIDER.isConsentRemembered(request, authorization, { secret: env.COOKIE_ENCRYPTION_KEY ?? "" })) {
      return beginGithubAuthorization(env, authorization, new Headers());
    }
  } catch {
    return errorPage(503, "OAuth remembered-consent configuration is unavailable.");
  }
  let consent;
  try {
    consent = await env.OAUTH_PROVIDER.beginConsent(authorization);
  } catch {
    return errorPage(503, "OAuth consent storage is unavailable.");
  }
  let client;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(authorization.clientId);
  } catch {
    return errorPage(503, "OAuth client registration could not be loaded.");
  }
  const clientName = escapeHtml(client?.clientName ?? "MCP client");
  const scopes = scopesToGrant(authorization).map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  return html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize HOW Mureka MCP</title><body><h1>Authorize HOW Mureka MCP</h1><p><strong>${clientName}</strong> requests access to this private Mureka MCP server.</p><ul>${scopes}</ul><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><button name="decision" value="allow" type="submit">Allow</button><button name="decision" value="deny" type="submit">Deny</button></form></body></html>`, consent.headers);
}

async function submitConsent(request: Request, env: OAuthEnv): Promise<Response> {
  const problem = configurationProblem(env);
  if (problem) return errorPage(503, problem);
  const form = await request.formData();
  const handle = form.get("handle");
  const decision = form.get("decision");
  if (typeof handle !== "string" || (decision !== "allow" && decision !== "deny")) return errorPage(400, "Invalid consent request.");
  try {
    if (decision === "deny") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return redirect(denied.headers, denied.redirectTo);
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: undefined, remember: { secret: env.COOKIE_ENCRYPTION_KEY ?? "", maxAgeSeconds: 24 * 60 * 60 } });
    return beginGithubAuthorization(env, approved.request, approved.headers);
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function githubCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const problem = configurationProblem(env);
  if (problem) return errorPage(503, problem);
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return errorPage(400, "GitHub did not provide an authorization code.");
  try {
    const upstream = await env.OAUTH_PROVIDER.finishUpstream(request);
    const githubAccessToken = await exchangeGithubCode(env, code);
    const githubUserId = await getGithubNumericUserId(githubAccessToken);
    if (!(await timingSafeEqual(githubUserId, env.ALLOWED_GITHUB_USER_ID ?? ""))) return errorPage(403, "This GitHub identity is not authorized for HOW Mureka MCP.");
    const completed = await env.OAUTH_PROVIDER.completeAuthorization({ request: upstream.request, userId: githubUserId, metadata: { label: "Authorized GitHub identity" }, props: { githubUserId }, scope: scopesToGrant(upstream.request) });
    return redirect(upstream.headers, completed.redirectTo);
  } catch (error) {
    return errorPage(400, error instanceof AuthorizationError ? "OAuth authorization could not be completed." : "GitHub authentication could not be completed.");
  }
}

export const GitHubOAuthHandler = {
  async fetch(request: Request, env: OAuthEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/authorize" && request.method === "GET") return showConsent(request, env);
    if (path === "/authorize" && request.method === "POST") return submitConsent(request, env);
    if (path === "/callback" && request.method === "GET") return githubCallback(request, env);
    return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
};
