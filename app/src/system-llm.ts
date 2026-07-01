import type { Env } from "./env";

export type SystemModelTier = "flash" | "pro";

export function officialSystemModel(env: Env, requested: string | SystemModelTier): string {
  const value = String(requested || "").toLowerCase();
  return value === "pro" || value.includes("pro") || requested === env.MODEL_PRO
    ? "deepseek-v4-pro"
    : "deepseek-v4-flash";
}

export function deepseekChatUrl(env: Env): string {
  return `${String(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
}

export async function completeSystemChat(
  env: Env,
  model: string | SystemModelTier,
  messages: { role: string; content: string }[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    json?: boolean;
    thinking?: boolean;
  } = {},
): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120000);
  try {
    const body: Record<string, any> = {
      model: officialSystemModel(env, model),
      messages,
      max_tokens: opts.maxTokens ?? 800,
      thinking: { type: opts.thinking ? "enabled" : "disabled" },
    };
    if (!opts.thinking) body.temperature = opts.temperature ?? 0.2;
    if (opts.json) body.response_format = { type: "json_object" };
    const res = await fetch(deepseekChatUrl(env), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new Error(`DeepSeek system API HTTP ${res.status}: ${detail}`);
    }
    const payload: any = await res.json().catch(() => null);
    return String(payload?.choices?.[0]?.message?.content || "");
  } finally {
    clearTimeout(timeout);
  }
}

