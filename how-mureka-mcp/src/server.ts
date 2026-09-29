import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { insufficientScope, OAuthProvider, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import {
  executeGeneration,
  getBillingSnapshot,
  getGenerationStatus,
  MUREKA_API_BASE,
  prepareGeneration,
  prepareInput,
  songModels,
  type MurekaEnv
} from "./generation";
import { GitHubOAuthHandler, type GitHubAuthProps, type OAuthEnv, type OAuthProviderEnv } from "./oauth";

const MCP_RESOURCE = "https://how-mureka-mcp.how-mureka-mcp.workers.dev/mcp";
const READ_SCOPE = "mureka:read";
const PREPARE_SCOPE = "mureka:prepare";
const EXECUTE_SCOPE = "mureka:execute";

function requiredScopeForMcpRequest(request: Request): Promise<string> {
  if (request.method !== "POST") return Promise.resolve(READ_SCOPE);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) return Promise.resolve(READ_SCOPE);
  return request.clone().text().then((body) => {
    if (body.length > 64 * 1024) return READ_SCOPE;
    try {
      const message: unknown = JSON.parse(body);
      if (typeof message !== "object" || message === null || Array.isArray(message)) return READ_SCOPE;
      const method = (message as Record<string, unknown>).method;
      const params = (message as Record<string, unknown>).params;
      if (method !== "tools/call" || typeof params !== "object" || params === null || Array.isArray(params)) return READ_SCOPE;
      const name = (params as Record<string, unknown>).name;
      if (name === "prepare_song_generation") return PREPARE_SCOPE;
      if (name === "execute_song_generation") return EXECUTE_SCOPE;
      return READ_SCOPE;
    } catch {
      return READ_SCOPE;
    }
  });
}

function scopeAllows(grantedScopes: string[], requiredScope: string): boolean {
  if (requiredScope === READ_SCOPE) return grantedScopes.includes(READ_SCOPE) || grantedScopes.includes(PREPARE_SCOPE) || grantedScopes.includes(EXECUTE_SCOPE);
  if (requiredScope === PREPARE_SCOPE) return grantedScopes.includes(PREPARE_SCOPE) || grantedScopes.includes(EXECUTE_SCOPE);
  return grantedScopes.includes(EXECUTE_SCOPE);
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

function isAuthenticatedMcpContext(context: ExecutionContext): context is OAuthResourceContext<GitHubAuthProps> {
  const props = context.props;
  if (typeof props !== "object" || props === null || Array.isArray(props)) return false;
  if (typeof (props as Record<string, unknown>).githubUserId !== "string") return false;
  return "auth" in context;
}

function asText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function createServer(env: MurekaEnv) {
  const server = new McpServer({
    name: "HOW Mureka MCP",
    version: "0.3.0"
  });

  server.registerTool(
    "get_api_status",
    {
      description:
        "Read-only health check for the HOW Mureka integration. Does not generate music and does not consume Mureka API credits.",
      inputSchema: {}
    },
    async () => {
      return asText({
        service: "Mureka API",
        api_base: MUREKA_API_BASE,
        api_key_configured: Boolean(env.MUREKA_API_KEY),
        mode: "OAuth-protected read, preparation, and confirmation-gated execution",
        paid_execution_enabled: env.MUREKA_EXECUTION_AUTH_MODE === "oauth",
        paid_execution_block_reason:
          env.MUREKA_EXECUTION_AUTH_MODE === "oauth"
            ? null
            : "OAuth-protected MCP caller authentication is not configured."
      });
    }
  );

  server.registerTool(
    "get_billing",
    {
      description:
        "Read the Mureka API billing endpoint without generating music. Amounts, when present, are reported in cents exactly as returned by Mureka.",
      inputSchema: {}
    },
    async () => asText(await getBillingSnapshot(env))
  );

  server.registerTool(
    "prepare_song_generation",
    {
      description:
        "Prepare a one-time, expiring Mureka song or instrumental confirmation. This tool never calls a paid Mureka generation endpoint.",
      inputSchema: {
        title: z.string().min(1).max(200).optional(),
        generation_type: z.enum(["song", "instrumental"]).optional(),
        lyrics: z.string().min(1).max(5000).optional(),
        prompt: z.string().min(1).max(1024).optional(),
        model: z.enum(songModels).optional(),
        gender: z.enum(["female", "male"]).optional(),
        reference_id: z.string().min(1).max(200).optional(),
        vocal_id: z.string().min(1).max(200).optional(),
        melody_id: z.string().min(1).max(200).optional(),
        instrumental_id: z.string().min(1).max(200).optional(),
        n: z.number().int().min(1).max(3).optional(),
        stream: z.boolean().optional()
      }
    },
    async (input) => asText(await prepareGeneration(env, prepareInput.parse(input)))
  );

  server.registerTool(
    "execute_song_generation",
    {
      description:
        "Paid mutation. Requires a valid one-time pending ID and explicit human confirmation. It remains fail-closed until OAuth-protected MCP caller authentication is configured.",
      inputSchema: {
        pending_generation_id: z.string().uuid(),
        human_confirmation: z.literal("I_CONFIRM_MUREKA_API_CHARGE")
      }
    },
    async ({ pending_generation_id, human_confirmation }) =>
      asText(await executeGeneration(env, pending_generation_id, human_confirmation))
  );

  server.registerTool(
    "get_generation_status",
    {
      description:
        "Read a locally prepared generation or a Mureka task previously submitted by this MCP. It never creates music.",
      inputSchema: { generation_id_or_task_id: z.string().min(1).max(200) }
    },
    async ({ generation_id_or_task_id }) => asText(await getGenerationStatus(env, generation_id_or_task_id))
  );

  return server;
}

export default {
  fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext) {
    const providerEnv: OAuthProviderEnv = { ...env, OAUTH_KV: env.MUREKA_OAUTH_KV };
    return oauthProvider.fetch(request, providerEnv, ctx);
  }
} satisfies ExportedHandler<OAuthEnv>;

const mcpApiHandler = {
  async fetch(request: Request, env: OAuthProviderEnv, ctx: ExecutionContext) {
    if (!isAuthenticatedMcpContext(ctx)) {
      return new Response("Access denied.", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (!(await timingSafeEqual(ctx.props.githubUserId, env.ALLOWED_GITHUB_USER_ID ?? ""))) {
      return new Response("Access denied.", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    const requiredScope = await requiredScopeForMcpRequest(request);
    if (!scopeAllows(ctx.auth.scope, requiredScope)) {
      return insufficientScope(ctx.auth, [requiredScope], "This MCP operation requires an additional HOW Mureka scope.");
    }
    return createMcpHandler(() => createServer(env), {
      route: "/mcp",
      authContext: { props: ctx.props }
    })(request, env, ctx);
  }
};

const oauthProvider = new OAuthProvider<OAuthProviderEnv>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: GitHubOAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60,
  refreshTokenIdleTTL: 30 * 24 * 60 * 60,
  scopesSupported: [READ_SCOPE, PREPARE_SCOPE, EXECUTE_SCOPE],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: ["https://how-mureka-mcp.how-mureka-mcp.workers.dev"],
    scopes_supported: [READ_SCOPE, PREPARE_SCOPE, EXECUTE_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "HOW Mureka MCP"
  },
  clientIdMetadataDocumentEnabled: true,
  cookiePrefix: "__Host-how-mureka-oauth-"
});
