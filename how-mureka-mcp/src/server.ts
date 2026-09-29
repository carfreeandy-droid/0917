import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
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
    version: "0.2.0"
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
        mode: "read-only plus confirmation preparation",
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
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
