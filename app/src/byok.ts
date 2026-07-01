// BYOK (Bring Your Own Key) — user-provided LLM API keys and endpoints.
// When a user selects a BYOK model, calls go directly to their provider, bypassing the system
// User-selected models go through the user/OpenRouter path. System KOL distillation uses the separate
// DeepSeek official client in system-llm.ts and never reads a user's BYOK configuration.
import type { Env } from "./env";

// ---- Provider configs (built-in) ----

export interface ByokProvider {
  id: string;
  group: string;
  name: string;
  baseUrl: string;
  color: string;
  badge: string;
  dflt?: boolean;
  models: string[];
}

export const BYOK_PROVIDERS: ByokProvider[] = [
  {
    id: "openrouter",
    group: "OpenRouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    color: "#71717A",
    badge: "OR",
    models: [
      "openai/gpt-4o",
      "openai/gpt-4.1",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-chat",
      "meta-llama/llama-4-maverick",
      "qwen/qwen3-235b-a22b",
      "mistralai/mistral-large",
      "x-ai/grok-4.1",
    ],
  },
  {
    id: "deepseek",
    group: "DeepSeek",
    name: "DeepSeek API",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    color: "#4D6BFE",
    badge: "DS",
    dflt: true,
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "custom",
    group: "Custom",
    name: "自定义 API",
    baseUrl: "",
    color: "#6B7280",
    badge: "API",
    models: ["Auto"],
  },
];

export function getProvider(id: string): ByokProvider | undefined {
  return BYOK_PROVIDERS.find((p) => p.id === id);
}

// ---- D1 row shape ----

export interface ByokModelRow {
  id: string;
  user_id: string;
  provider: string;
  model_name: string;
  display_name: string;
  base_url: string;
  api_key: string;
  color: string;
  badge: string;
  created_at: number;
}

export interface ByokModelConfig {
  id: string;
  providerId: string;
  providerName: string;
  modelName: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  color: string;
  badge: string;
}

function rowToConfig(r: ByokModelRow): ByokModelConfig {
  return {
    id: r.id,
    providerId: r.provider,
    providerName: (getProvider(r.provider)?.name || r.provider),
    modelName: r.model_name,
    displayName: r.display_name,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    color: r.color,
    badge: r.badge,
  };
}

// ---- DB CRUD ----

/** List all BYOK models for a user. */
export async function listByokModels(env: Env, userId: string): Promise<ByokModelConfig[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM byok_models WHERE user_id=? ORDER BY created_at DESC`
  ).bind(userId).all<ByokModelRow>();
  return (rows.results || []).map(rowToConfig);
}

/** Get a single BYOK model by ID (must belong to the given user). */
export async function getByokModel(env: Env, userId: string, modelId: string): Promise<ByokModelConfig | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM byok_models WHERE user_id=? AND id=?`
  ).bind(userId, modelId).first<ByokModelRow>();
  return row ? rowToConfig(row) : null;
}

/** Find a BYOK model config by its public model ID (the cm_xxx id the client uses). */
export async function getByokConfigByModelId(env: Env, userId: string, modelId: string): Promise<ByokModelConfig | null> {
  return getByokModel(env, userId, modelId);
}

/** Save (upsert) a BYOK model for a user. */
export async function saveByokModel(
  env: Env,
  userId: string,
  cfg: { id?: string; providerId: string; providerName?: string; modelName: string; displayName?: string; baseUrl?: string; apiKey: string; color?: string; badge?: string }
): Promise<ByokModelConfig> {
  const prov = getProvider(cfg.providerId) || BYOK_PROVIDERS.find((p) => p.id === "custom")!;
  const id = cfg.id || ("cm_" + crypto.randomUUID().slice(0, 8));
  const displayName = cfg.displayName || ((cfg.modelName && cfg.modelName !== "Auto") ? `${cfg.modelName} · ${prov.name}` : `${prov.name} · Auto`);
  const baseUrl = cfg.baseUrl || prov.baseUrl || "";
  const color = cfg.color || prov.color;
  const badge = cfg.badge || prov.badge;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT OR REPLACE INTO byok_models (id,user_id,provider,model_name,display_name,base_url,api_key,color,badge,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, userId, cfg.providerId, cfg.modelName, displayName, baseUrl, cfg.apiKey, color, badge, now).run();

  return {
    id,
    providerId: cfg.providerId,
    providerName: cfg.providerName || prov.name,
    modelName: cfg.modelName,
    displayName,
    baseUrl,
    apiKey: cfg.apiKey,
    color,
    badge,
  };
}

/** Delete a BYOK model. Returns true if a row was actually deleted. */
export async function deleteByokModel(env: Env, userId: string, modelId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM byok_models WHERE user_id=? AND id=?`
  ).bind(userId, modelId).run();
  return (result.meta?.changes || 0) > 0;
}

// ---- LLM calling (direct to user's API) ----

const BYOK_TIMEOUT_MS = 120000;

/** Call a BYOK model's API (non-streaming). Returns "" on any failure. */
export async function byokCompleteChat(
  cfg: ByokModelConfig,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BYOK_TIMEOUT_MS);
    const res = await fetch(cfg.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        "HTTP-Referer": "https://robindex.ai",
        "X-Title": "Robindex",
      },
      body: JSON.stringify({
        model: cfg.modelName === "Auto" ? undefined : cfg.modelName,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 600,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`byokCompleteChat HTTP ${res.status} provider=${cfg.providerId}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return "";
    }
    const j: any = await res.json().catch(() => null);
    return j?.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.warn(`byokCompleteChat error provider=${cfg.providerId}: ${String(e).slice(0, 200)}`);
    return "";
  }
}

/** Call a BYOK model's API (streaming). Returns the raw upstream Response. */
export async function byokStreamChat(
  cfg: ByokModelConfig,
  messages: { role: string; content: string }[],
  opts: { temperature?: number } = {}
): Promise<Response> {
  return fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      "HTTP-Referer": "https://robindex.ai",
      "X-Title": "Robindex",
    },
    body: JSON.stringify({
      model: cfg.modelName === "Auto" ? undefined : cfg.modelName,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.6,
    }),
  });
}

/** Call a BYOK model's API for tool-calling (non-streaming). */
export async function byokToolCall(
  cfg: ByokModelConfig,
  messages: any[],
  tools: any[],
): Promise<Response> {
  return fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      "HTTP-Referer": "https://robindex.ai",
      "X-Title": "Robindex",
    },
    body: JSON.stringify({
      model: cfg.modelName === "Auto" ? undefined : cfg.modelName,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 1500,
    }),
  });
}
