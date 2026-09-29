import { z } from "zod";

export type MurekaEnv = Env & {
  MUREKA_API_KEY?: string;
  /** Fail closed until a protected MCP OAuth flow is configured. */
  MUREKA_EXECUTION_AUTH_MODE?: string;
};

export const MUREKA_API_BASE = "https://api.mureka.ai";
const PREPARE_TTL_SECONDS = 15 * 60;
const MAX_UPSTREAM_RESPONSE_BYTES = 256 * 1024;

export const songModels = ["auto", "mureka-7.6", "mureka-o2", "mureka-8", "mureka-9", "mureka-9.5"] as const;
const instrumentalModels = ["auto", "mureka-7.6", "mureka-8", "mureka-9", "mureka-9.5"] as const;

export const prepareInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  generation_type: z.enum(["song", "instrumental"]).default("song"),
  lyrics: z.string().trim().min(1).max(5000).optional(),
  prompt: z.string().trim().min(1).max(1024).optional(),
  model: z.enum(songModels).default("auto"),
  gender: z.enum(["female", "male"]).optional(),
  reference_id: z.string().trim().min(1).max(200).optional(),
  vocal_id: z.string().trim().min(1).max(200).optional(),
  melody_id: z.string().trim().min(1).max(200).optional(),
  instrumental_id: z.string().trim().min(1).max(200).optional(),
  n: z.number().int().min(1).max(3).default(1),
  stream: z.boolean().default(false)
}).strict();

type PrepareInput = z.infer<typeof prepareInput>;

export type BillingSnapshot = {
  account_status: "ok";
  balance_cents: number | null;
  total_recharge_cents: number | null;
  total_spending_cents: number | null;
  concurrent_request_limit: number | null;
  queried_at: string;
  source: "/v1/account/billing";
  missing_fields: string[];
};

type MurekaTask = {
  id?: string;
  created_at?: number;
  finished_at?: number;
  model?: string;
  status?: string;
  failed_reason?: string;
  choices?: Array<{ id?: string; index?: number; url?: string; flac_url?: string; wav_url?: string; stream_url?: string; duration?: number }>;
};

type GenerationRow = {
  id: string; created_at: number; updated_at: number; prepared_at: number; confirmed_at: number | null; expires_at: number;
  title: string | null; generation_type: "song" | "instrumental"; model: string; lyrics: string | null; prompt: string | null;
  parameters_json: string; quantity: number; status: string; confirmation_status: string; mureka_task_id: string | null;
  before_balance_cents: number | null; after_balance_cents: number | null; actual_spending_cents: number | null;
  result_url: string | null; result_json: string | null; error_code: string | null; error_message: string | null;
};

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asOptionalInteger(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
function safeErrorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unknown error"; }

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_RESPONSE_BYTES) throw new Error("Upstream response exceeds the permitted size.");
  const raw = await response.text();
  if (raw.length > MAX_UPSTREAM_RESPONSE_BYTES) throw new Error("Upstream response exceeds the permitted size.");
  try { return JSON.parse(raw); } catch { throw new Error("Mureka returned a non-JSON response."); }
}

async function callMureka(env: MurekaEnv, path: string, init: RequestInit): Promise<unknown> {
  if (!env.MUREKA_API_KEY) throw new Error("MUREKA_API_KEY is not configured on the server.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.MUREKA_API_KEY}`);
  headers.set("Accept", "application/json");
  const response = await fetch(`${MUREKA_API_BASE}${path}`, { ...init, headers });
  const body = await readBoundedJson(response);
  if (!response.ok) {
    const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : `Mureka request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

export async function getBillingSnapshot(env: MurekaEnv): Promise<BillingSnapshot> {
  const body = await callMureka(env, "/v1/account/billing", { method: "GET" });
  const billing = isRecord(body) ? body : {};
  const fields: Array<[string, "balance_cents" | "total_recharge_cents" | "total_spending_cents" | "concurrent_request_limit"]> = [
    ["balance", "balance_cents"], ["total_recharge", "total_recharge_cents"], ["total_spending", "total_spending_cents"], ["concurrent_request_limit", "concurrent_request_limit"]
  ];
  return {
    account_status: "ok",
    balance_cents: asOptionalInteger(billing.balance),
    total_recharge_cents: asOptionalInteger(billing.total_recharge),
    total_spending_cents: asOptionalInteger(billing.total_spending),
    concurrent_request_limit: asOptionalInteger(billing.concurrent_request_limit),
    queried_at: new Date().toISOString(),
    source: "/v1/account/billing",
    missing_fields: fields.filter(([field]) => asOptionalInteger(billing[field]) === null).map(([field]) => field)
  };
}

function validateInput(input: PrepareInput): void {
  if (input.generation_type === "song") {
    if (!input.lyrics) throw new Error("lyrics is required when generation_type is song.");
    if (input.model === "mureka-o2" && (input.vocal_id || input.melody_id)) throw new Error("mureka-o2 does not support vocal_id or melody_id.");
    if (input.melody_id && (input.prompt || input.reference_id || input.vocal_id || input.gender)) throw new Error("melody_id cannot be combined with prompt, reference_id, vocal_id, or gender.");
    if (input.instrumental_id) throw new Error("instrumental_id is only supported when generation_type is instrumental.");
    return;
  }
  if (!input.prompt && !input.instrumental_id) throw new Error("prompt or instrumental_id is required when generation_type is instrumental.");
  if (input.prompt && input.instrumental_id) throw new Error("prompt and instrumental_id cannot be combined for instrumental generation.");
  if (input.lyrics || input.gender || input.reference_id || input.vocal_id || input.melody_id) throw new Error("lyrics, gender, reference_id, vocal_id, and melody_id are not supported for instrumental generation.");
  if (!instrumentalModels.includes(input.model as (typeof instrumentalModels)[number])) throw new Error("The selected model is not supported for instrumental generation.");
}

function payloadFor(input: PrepareInput): Record<string, unknown> {
  if (input.generation_type === "instrumental") {
    return { model: input.model, n: input.n, stream: input.stream, ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.instrumental_id ? { instrumental_id: input.instrumental_id } : {}) };
  }
  return { lyrics: input.lyrics, model: input.model, n: input.n, stream: input.stream, ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.gender ? { gender: input.gender } : {}), ...(input.reference_id ? { reference_id: input.reference_id } : {}), ...(input.vocal_id ? { vocal_id: input.vocal_id } : {}), ...(input.melody_id ? { melody_id: input.melody_id } : {}) };
}

function endpointFor(type: "song" | "instrumental", operation: "generate" | "query"): string {
  return type === "instrumental" ? (operation === "generate" ? "/v1/instrumental/generate" : "/v1/instrumental/query") : (operation === "generate" ? "/v1/song/generate" : "/v1/song/query");
}

async function loadGeneration(env: MurekaEnv, idOrTaskId: string): Promise<GenerationRow | null> {
  return env.MUREKA_STATE.prepare("SELECT * FROM generation_requests WHERE id = ? OR mureka_task_id = ? LIMIT 1").bind(idOrTaskId, idOrTaskId).first<GenerationRow>();
}

function publicGeneration(row: GenerationRow, billing?: BillingSnapshot) {
  let parameters: unknown = {}; let result: unknown = null;
  try { parameters = JSON.parse(row.parameters_json); } catch { /* Invalid persisted data is not exposed. */ }
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* Invalid persisted data is not exposed. */ }
  return {
    generation_id: row.id,
    created_at: new Date(row.created_at * 1000).toISOString(),
    prepared_at: new Date(row.prepared_at * 1000).toISOString(),
    confirmed_at: row.confirmed_at ? new Date(row.confirmed_at * 1000).toISOString() : null,
    expires_at: new Date(row.expires_at * 1000).toISOString(),
    title: row.title, generation_type: row.generation_type, model: row.model, lyrics: row.lyrics, prompt: row.prompt, parameters, n: row.quantity, status: row.status,
    confirmation: { state: row.confirmation_status, one_time: true, expired: row.expires_at <= nowSeconds() },
    mureka_task_id: row.mureka_task_id, result_url: row.result_url, result,
    cost: { before_balance_cents: row.before_balance_cents, after_balance_cents: row.after_balance_cents, actual_spending_cents: row.actual_spending_cents, actual_cost: row.actual_spending_cents === null ? "unknown" : "reported_by_api" },
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    ...(billing ? { billing } : {})
  };
}

export async function prepareGeneration(env: MurekaEnv, input: PrepareInput) {
  validateInput(input);
  const billing = await getBillingSnapshot(env);
  const now = nowSeconds(); const id = crypto.randomUUID(); const parameters = payloadFor(input);
  await env.MUREKA_STATE.prepare(`INSERT INTO generation_requests (id, created_at, updated_at, prepared_at, expires_at, title, generation_type, model, lyrics, prompt, parameters_json, quantity, status, confirmation_status, before_balance_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_confirmation', 'pending', ?)`)
    .bind(id, now, now, now, now + PREPARE_TTL_SECONDS, input.title ?? null, input.generation_type, input.model, input.lyrics ?? null, input.prompt ?? null, JSON.stringify(parameters), input.n, billing.balance_cents).run();
  const row = await loadGeneration(env, id);
  if (!row) throw new Error("Could not load the prepared generation.");
  return { ...publicGeneration(row, billing), will_call_paid_api_on_execute: true, estimated_cost: "unavailable", cost_notice: "Mureka's billing endpoint does not provide a per-request quote. No cost estimate has been invented.", execute_available: false, execute_block_reason: "MCP caller OAuth is not configured; paid execution remains fail-closed." };
}

export async function executeGeneration(env: MurekaEnv, id: string, humanConfirmation: string) {
  if (humanConfirmation !== "I_CONFIRM_MUREKA_API_CHARGE") throw new Error("Explicit human confirmation is required before Mureka can be called.");
  if (env.MUREKA_EXECUTION_AUTH_MODE !== "oauth") throw new Error("Paid execution is disabled until OAuth-protected MCP caller authentication is configured. No Mureka generation request was sent.");
  const now = nowSeconds();
  const reserved = await env.MUREKA_STATE.prepare("UPDATE generation_requests SET status = 'submitting', confirmation_status = 'executing', confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_confirmation' AND confirmation_status = 'pending' AND expires_at > ?").bind(now, now, id, now).run();
  if (reserved.meta.changes !== 1) {
    const row = await loadGeneration(env, id);
    if (!row) throw new Error("Unknown pending generation ID.");
    if (row.expires_at <= now) { await env.MUREKA_STATE.prepare("UPDATE generation_requests SET status = 'expired', confirmation_status = 'expired', updated_at = ? WHERE id = ?").bind(now, id).run(); throw new Error("This confirmation has expired. Prepare a new generation."); }
    throw new Error("This confirmation was already used or is no longer executable.");
  }
  const row = await loadGeneration(env, id);
  if (!row) throw new Error("Could not load the reserved generation.");
  try {
    const task = await callMureka(env, endpointFor(row.generation_type, "generate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: row.parameters_json });
    if (!isRecord(task) || typeof task.id !== "string" || task.id.length === 0) throw new Error("Mureka did not return a task ID.");
    await env.MUREKA_STATE.prepare("UPDATE generation_requests SET mureka_task_id = ?, status = 'running', confirmation_status = 'used', updated_at = ?, result_json = ? WHERE id = ?").bind(task.id, nowSeconds(), JSON.stringify(task), id).run();
  } catch (error) {
    await env.MUREKA_STATE.prepare("UPDATE generation_requests SET status = 'failed', confirmation_status = 'used', updated_at = ?, error_code = 'generation_submission_failed', error_message = ? WHERE id = ?").bind(nowSeconds(), safeErrorMessage(error), id).run();
    throw error;
  }
  const updated = await loadGeneration(env, id);
  if (!updated) throw new Error("Could not load the submitted generation.");
  return publicGeneration(updated);
}

export async function getGenerationStatus(env: MurekaEnv, idOrTaskId: string) {
  const row = await loadGeneration(env, idOrTaskId);
  if (!row) throw new Error("No generation record exists for this local generation ID or Mureka task ID.");
  if (!row.mureka_task_id || !["submitting", "running"].includes(row.status)) return publicGeneration(row);
  const body = await callMureka(env, `${endpointFor(row.generation_type, "query")}/${encodeURIComponent(row.mureka_task_id)}`, { method: "GET" });
  const task = isRecord(body) ? (body as MurekaTask) : {};
  const status = typeof task.status === "string" ? task.status : "running";
  const choices = Array.isArray(task.choices) ? task.choices : [];
  const first = choices[0]; const terminal = ["succeeded", "failed", "timeouted", "cancelled"].includes(status);
  const localStatus = status === "succeeded" ? "succeeded" : terminal ? "failed" : "running";
  await env.MUREKA_STATE.prepare("UPDATE generation_requests SET updated_at = ?, status = ?, result_url = ?, result_json = ?, error_code = ?, error_message = ? WHERE id = ?")
    .bind(nowSeconds(), localStatus, first?.url ?? first?.stream_url ?? null, JSON.stringify({ id: task.id, status, created_at: task.created_at, finished_at: task.finished_at, model: task.model, choices }), terminal && status !== "succeeded" ? status : null, terminal && status !== "succeeded" ? task.failed_reason ?? "Mureka task did not succeed." : null, row.id).run();
  const updated = await loadGeneration(env, row.id);
  return publicGeneration(updated ?? row);
}
