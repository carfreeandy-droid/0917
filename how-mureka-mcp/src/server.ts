import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

interface Env {
  MUREKA_API_KEY?: string;
}

const MUREKA_API_BASE = "https://api.mureka.ai";

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

function createServer(env: Env) {
  const server = new McpServer({
    name: "HOW Mureka MCP",
    version: "0.1.0"
  });

  server.registerTool(
    "get_api_status",
    {
      description:
        "Read-only health check for the HOW Mureka integration. Verifies whether the server has a Mureka API key configured. Does not generate music and does not consume generation credits.",
      inputSchema: {}
    },
    async () => {
      return asText({
        service: "Mureka API",
        api_base: MUREKA_API_BASE,
        api_key_configured: Boolean(env.MUREKA_API_KEY),
        mode: "read-only",
        generation_enabled: false
      });
    }
  );

  server.registerTool(
    "get_billing",
    {
      description:
        "Read the authenticated Mureka API account billing/credit information. This is read-only and does not generate music or consume song-generation credits.",
      inputSchema: {}
    },
    async () => {
      if (!env.MUREKA_API_KEY) {
        throw new Error(
          "MUREKA_API_KEY is not configured on the server. Add it as a Cloudflare secret before using get_billing."
        );
      }

      const response = await fetch(`${MUREKA_API_BASE}/v1/account/billing`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.MUREKA_API_KEY}`,
          Accept: "application/json"
        }
      });

      const raw = await response.text();
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Keep raw text when the upstream response is not JSON.
      }

      if (!response.ok) {
        throw new Error(
          `Mureka billing request failed with HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`
        );
      }

      return asText({
        service: "Mureka API",
        endpoint: "/v1/account/billing",
        read_only: true,
        billing: body
      });
    }
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
