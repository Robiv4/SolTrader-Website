import type { AiTokenAnalysisInput } from './input.js';
import { AI_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { AI_OUTPUT_JSON_SCHEMA } from './schema.js';

export type AiProviderStatus = 'CONNECTED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

/** Raw provider answer: the unvalidated JSON object plus usage facts reported by the provider. */
export interface AiProviderResult {
  output: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Vendor-independent AI provider. It only turns an analysis input into an (unvalidated) answer; it has no
 * access to wallets, signing, accounts or execution, and never receives secrets other than its own API key.
 */
export interface AIProvider {
  analyzeToken(input: AiTokenAnalysisInput, signal?: globalThis.AbortSignal): Promise<AiProviderResult>;
  healthCheck(signal?: globalThis.AbortSignal): Promise<boolean>;
  getProviderName(): string;
  getModelName(): string;
}

export class AiProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code = 'AI_PROVIDER_UNAVAILABLE') {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetcher?: typeof globalThis.fetch;
  /** Name reported in analyses/UI (e.g. "openai", "xai", "groq"). */
  providerName?: string;
  /**
   * json_schema: strict schema-constrained output (OpenAI, xAI). json_object: plain JSON mode with the schema in
   * the system prompt, for models without schema support (Llama 3 / DeepSeek on Groq). Both are validated server-side.
   */
  structuredOutput?: 'json_schema' | 'json_object';
  /** Extra request fields for a vendor (e.g. Groq's reasoning_format for DeepSeek R1). */
  extraBody?: Record<string, unknown>;
}

/** Takes the JSON object out of a model reply (tolerates code fences and <think> blocks of reasoning models). */
export function extractJsonObject(content: string): unknown {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : withoutThinking).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('No JSON object in reply');
  }
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Chat Completions provider with strict JSON-schema structured output. Works with every OpenAI-compatible
 * API (OpenAI, xAI Grok); only the base URL, key and model differ.
 */
export class OpenAICompatibleProvider implements AIProvider {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/$/, '');
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  getProviderName() {
    return this.options.providerName ?? 'openai';
  }

  getModelName() {
    return this.options.model;
  }

  private headers() {
    return { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' };
  }

  private requestBody(input: AiTokenAnalysisInput) {
    const jsonObjectMode = this.options.structuredOutput === 'json_object';
    const system = jsonObjectMode
      ? `${AI_SYSTEM_PROMPT}\nThe JSON object must match exactly this JSON schema (all keys required, no extra keys):\n${JSON.stringify(AI_OUTPUT_JSON_SCHEMA)}`
      : AI_SYSTEM_PROMPT;
    return {
      model: this.options.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      response_format: jsonObjectMode
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'token_entry_analysis', strict: true, schema: AI_OUTPUT_JSON_SCHEMA } },
      ...(jsonObjectMode ? { temperature: 0.2 } : {}),
      ...this.options.extraBody,
    };
  }

  async analyzeToken(input: AiTokenAnalysisInput, signal?: globalThis.AbortSignal): Promise<AiProviderResult> {
    let response: globalThis.Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify(this.requestBody(input)),
      });
    } catch (error) {
      // Network failures and aborts (timeouts) are retryable; the message never contains request headers.
      throw new AiProviderError(error instanceof Error && error.name === 'AbortError' ? 'AI request timed out' : 'AI provider request failed', true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new AiProviderError(`AI provider returned HTTP ${response.status}`, retryable);
    }
    const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    const message = body?.choices?.[0]?.message;
    if (!message?.content) throw new AiProviderError(message?.refusal ? 'AI provider refused the request' : 'AI provider returned no content', false, 'AI_ANALYSIS_INVALID');
    let output: unknown;
    try {
      output = this.options.structuredOutput === 'json_object' ? extractJsonObject(message.content) : JSON.parse(message.content);
    } catch {
      throw new AiProviderError('AI provider returned non-JSON content', false, 'AI_ANALYSIS_INVALID');
    }
    return {
      output,
      inputTokens: typeof body?.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
      outputTokens: typeof body?.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null,
    };
  }

  /** Healthy when the key is accepted and the configured model is listed (GET /models, no cost). */
  async healthCheck(signal?: globalThis.AbortSignal) {
    try {
      const response = await this.fetcher(`${this.baseUrl}/models`, { headers: this.headers(), signal });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
      const ids = Array.isArray(body?.data) ? body!.data.map((model) => model.id) : null;
      return ids === null || ids.includes(this.options.model);
    } catch {
      return false;
    }
  }
}

/** OpenAI (kept for compatibility). */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(options: OpenAIProviderOptions) {
    super({ providerName: 'openai', ...options });
  }
}

/**
 * Groq (Llama 3, DeepSeek R1 distill, ...) via its OpenAI-compatible API. Uses JSON mode with the schema in the
 * prompt; DeepSeek reasoning is hidden so only the JSON answer comes back.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(options: OpenAIProviderOptions) {
    const reasoning = /deepseek|qwq|qwen3|r1/i.test(options.model);
    // An explicit but undefined baseUrl (no AI_BASE_URL) must not replace the Groq endpoint.
    super({ providerName: 'groq', structuredOutput: 'json_object', ...(reasoning ? { extraBody: { reasoning_format: 'hidden' } } : {}), ...options, baseUrl: options.baseUrl ?? GROQ_BASE_URL });
  }
}

/** xAI Grok via its OpenAI-compatible API (https://api.x.ai/v1). */
export class XaiProvider extends OpenAICompatibleProvider {
  constructor(options: OpenAIProviderOptions) {
    super({ providerName: 'xai', ...options, baseUrl: options.baseUrl ?? XAI_BASE_URL });
  }
}

export interface AiProviderEnvironment {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  GROQ_API_KEY?: string;
}

/** Safe, secret-free description of the configured provider (the only AI metadata sent to clients). */
export interface AiProviderInfo {
  provider: string | null;
  model: string | null;
  configured: boolean;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
/** Default Grok model; override with AI_MODEL (the health check verifies the model is available to the key). */
export const DEFAULT_XAI_MODEL = 'grok-4';
/** Default Groq model; any chat model listed for the key (GET /models) can be set via AI_MODEL. */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/** Builds the configured provider (or null when not configured). Add new vendors here, not in the trading engine. */
export function createAiProvider(environment: AiProviderEnvironment = process.env): { provider: AIProvider | null; info: AiProviderInfo } {
  const name = (environment.AI_PROVIDER ?? '').trim().toLowerCase();
  if (name === 'groq') {
    const apiKey = environment.GROQ_API_KEY?.trim();
    const model = environment.AI_MODEL?.trim() || DEFAULT_GROQ_MODEL;
    if (!apiKey) return { provider: null, info: { provider: 'groq', model, configured: false } };
    return { provider: new GroqProvider({ apiKey, model, baseUrl: environment.AI_BASE_URL?.trim() || undefined }), info: { provider: 'groq', model, configured: true } };
  }
  if (name === 'xai' || name === 'grok') {
    const apiKey = environment.XAI_API_KEY?.trim();
    const model = environment.AI_MODEL?.trim() || DEFAULT_XAI_MODEL;
    if (!apiKey) return { provider: null, info: { provider: 'xai', model, configured: false } };
    return { provider: new XaiProvider({ apiKey, model, baseUrl: environment.AI_BASE_URL?.trim() || undefined }), info: { provider: 'xai', model, configured: true } };
  }
  if (name === 'openai') {
    const apiKey = environment.OPENAI_API_KEY?.trim();
    const model = environment.AI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
    if (!apiKey) return { provider: null, info: { provider: 'openai', model, configured: false } };
    return { provider: new OpenAIProvider({ apiKey, model, baseUrl: environment.AI_BASE_URL?.trim() || undefined }), info: { provider: 'openai', model, configured: true } };
  }
  return { provider: null, info: { provider: name || null, model: environment.AI_MODEL?.trim() || null, configured: false } };
}
