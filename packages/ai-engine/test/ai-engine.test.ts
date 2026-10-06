import { describe, expect, it } from 'vitest';

import {
  AI_PROMPT_VERSION,
  AiInputValidationError,
  aiNumber,
  AiProviderError,
  applyAiPositionMultiplier,
  assertValidAiInput,
  automaticEntryDecisionSource,
  createAiProvider,
  DEFAULT_AI_USER_SETTINGS,
  effectiveAiDecision,
  isSignificantChange,
  marketStateHash,
  OpenAIProvider,
  XaiProvider,
  GroqProvider,
  extractJsonObject,
  recheckDelaySeconds,
  type AiTokenAnalysis,
  type AiTokenAnalysisInput,
  validateAiTokenAnalysis,
} from '../src/index.js';

const NOW = new Date('2026-09-28T12:00:00Z');

function answer(overrides: Partial<AiTokenAnalysis> = {}): AiTokenAnalysis {
  return {
    decision: 'BUY', confidence: 84, entryQuality: 78, marketStrength: 84, momentumQuality: 80, liquidityQuality: 71, timingQuality: 86, exhaustionRisk: 24,
    recommendedPositionMultiplier: 0.4, suggestedStopLossPercent: 15, suggestedTakeProfitPercent: 30, suggestedTrailingActivationPercent: 12, suggestedTrailingDistancePercent: 6,
    recheckSeconds: 30, reasons: ['Növekvő vételi nyomás'], warnings: ['Magas volatilitás'], ...overrides,
  };
}

function input(overrides: { market?: Partial<AiTokenAnalysisInput['market']>; risk?: Partial<AiTokenAnalysisInput['risk']>; exhaustionScore?: number | null; evaluatedAt?: string } = {}): AiTokenAnalysisInput {
  return {
    evaluatedAt: overrides.evaluatedAt ?? NOW.toISOString(),
    token: { address: 'TOKEN', symbol: 'TKN', name: null, tokenAgeMinutes: 120 },
    market: {
      priceUsd: 1, priceChange1m: 0.5, priceChange5m: 3, priceChange15m: 6, priceChange1h: 12, priceChange24h: 20, liquidityUsd: 100_000, liquidityChange5m: 1,
      liquidityChange15m: 3, volume5m: 20_000, volume1h: 150_000, volume24h: 2_000_000, volumeSpikeRatio: 2, volumeAcceleration: 1.3, buys5m: 120, sells5m: 80,
      buySellCountRatio: 1.5, buyShare5m: 0.6, buyShare1h: 0.55, buyVolume5m: null, sellVolume5m: null, averageTradeSizeUsd5m: 100, momentumWindows5m: [1, 2, 3],
      momentumAcceleration: 1, recentHigh30m: 1.02, recentLow30m: 0.9, distanceFromRecentHighPercent: -2, volatility30mPercent: 4, estimatedPriceImpactPercent: 0.2,
      marketCapUsd: 5_000_000, fdvUsd: 6_000_000, dataQuality: 'VALID', historyMinutes: 30, ...overrides.market,
    },
    risk: { riskScore: 60, classification: 'HIGH', factors: {}, warnings: [], hardBlocked: false, hardBlockReasons: [], security: {}, ...overrides.risk },
    strategyFeatures: { VolumeSpike: { status: 'OK', score: 80, triggered: true } },
    compositeScore: 70,
    exhaustionScore: overrides.exhaustionScore === undefined ? 20 : overrides.exhaustionScore,
    recentSnapshots: [],
  };
}

describe('AI output validation', () => {
  it('accepts a conforming answer', () => {
    expect(validateAiTokenAnalysis(answer()).ok).toBe(true);
  });

  it.each([
    ['unknown decision', { decision: 'SELL_EVERYTHING' }],
    ['confidence above 100', { confidence: 140 }],
    ['negative quality', { timingQuality: -1 }],
    ['multiplier above 1 (would increase size)', { recommendedPositionMultiplier: 1.5 }],
    ['stop loss outside safe bounds', { suggestedStopLossPercent: 95 }],
    ['recheck too fast', { recheckSeconds: 1 }],
    ['too many reasons', { reasons: Array.from({ length: 20 }, () => 'x') }],
    ['overlong text', { warnings: ['x'.repeat(500)] }],
    ['NaN', { confidence: Number.NaN }],
  ])('rejects %s', (_label, override) => {
    expect(validateAiTokenAnalysis({ ...answer(), ...override }).ok).toBe(false);
  });

  it('rejects extra fields such as execution commands', () => {
    expect(validateAiTokenAnalysis({ ...answer(), action: 'TRANSFER_FUNDS' }).ok).toBe(false);
    expect(validateAiTokenAnalysis('BUY now').ok).toBe(false);
    expect(validateAiTokenAnalysis(null).ok).toBe(false);
  });
});

describe('AI decision policy', () => {
  const settings = { ...DEFAULT_AI_USER_SETTINGS, aiAnalysisEnabled: true };

  it('exactly one automatic decision source', () => {
    expect(automaticEntryDecisionSource({ aiAnalysisEnabled: true })).toBe('AI');
    expect(automaticEntryDecisionSource({ aiAnalysisEnabled: false })).toBe('STRATEGY');
    expect(automaticEntryDecisionSource(null)).toBe('STRATEGY');
  });

  it('BUY below the minimum confidence becomes WATCH', () => {
    expect(effectiveAiDecision(answer({ confidence: 68 }), settings, 'HIGH')).toEqual({ decision: 'WATCH', reason: 'AI_CONFIDENCE_BELOW_THRESHOLD' });
    expect(effectiveAiDecision(answer({ confidence: 75 }), settings, 'HIGH')).toEqual({ decision: 'BUY', reason: null });
  });

  it('respects the risk-class toggles (and never allows EXTREME/BLOCKED)', () => {
    expect(effectiveAiDecision(answer(), settings, 'VERY_HIGH').decision).toBe('SKIP');
    expect(effectiveAiDecision(answer(), { ...settings, aiAllowVeryHighRisk: true }, 'VERY_HIGH').decision).toBe('BUY');
    expect(effectiveAiDecision(answer(), { ...settings, aiAllowHighRisk: false }, 'HIGH').decision).toBe('SKIP');
    expect(effectiveAiDecision(answer(), { ...settings, aiAllowVeryHighRisk: true }, 'EXTREME').decision).toBe('SKIP');
  });

  it('SKIP waits longer than WATCH before the next analysis', () => {
    expect(recheckDelaySeconds('SKIP', settings)).toBeGreaterThanOrEqual(120);
    expect(recheckDelaySeconds('WATCH', settings)).toBe(30);
  });

  it('the AI can only reduce the position size', () => {
    expect(applyAiPositionMultiplier(17.5, 50, 0.2)).toBeCloseTo(10, 10);
    expect(applyAiPositionMultiplier(17.5, 50, 1)).toBe(17.5);
    expect(applyAiPositionMultiplier(17.5, 50, 5)).toBe(17.5);
    expect(applyAiPositionMultiplier(17.5, 50, null)).toBe(17.5);
  });
});

describe('AI input', () => {
  it('normalises numbers: no NaN, Infinity or strings', () => {
    expect(aiNumber(Number.NaN)).toBeNull();
    expect(aiNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(aiNumber('1.5')).toBe(1.5);
    expect(aiNumber(undefined)).toBeNull();
  });

  it('refuses invalid price, stale data, missing risk analysis and hard blocks', () => {
    const code = (value: AiTokenAnalysisInput) => {
      try {
        assertValidAiInput(value, NOW);
        return 'OK';
      } catch (error) {
        return (error as AiInputValidationError).code;
      }
    };
    expect(code(input())).toBe('OK');
    expect(code(input({ market: { priceUsd: 0 } }))).toBe('INVALID_PRICE');
    expect(code(input({ evaluatedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }))).toBe('STALE_MARKET_DATA');
    expect(code(input({ market: { dataQuality: 'STALE' } }))).toBe('STALE_MARKET_DATA');
    expect(code(input({ risk: { riskScore: null } }))).toBe('RISK_ANALYSIS_MISSING');
    expect(code(input({ risk: { hardBlocked: true, hardBlockReasons: ['HONEYPOT_DETECTED'] } }))).toBe('HARD_BLOCKED');
    expect(code(input({ evaluatedAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() }))).toBe('INVALID_TIMESTAMP');
  });

  it('detects meaningful market changes and keeps the state hash stable for small moves', () => {
    expect(isSignificantChange(input(), input({ market: { priceUsd: 1.005 } }))).toBeNull();
    expect(marketStateHash(input())).toBe(marketStateHash(input({ market: { priceUsd: 1.005 } })));
    expect(isSignificantChange(input(), input({ market: { priceUsd: 1.05 } }))).toBe('PRICE_MOVE');
    expect(isSignificantChange(input(), input({ market: { volume5m: 40_000 } }))).toBe('VOLUME_CHANGE');
    expect(isSignificantChange(input(), input({ market: { liquidityUsd: 80_000 } }))).toBe('LIQUIDITY_CHANGE');
    expect(isSignificantChange(input(), input({ risk: { classification: 'VERY_HIGH' } }))).toBe('RISK_CLASS_CHANGE');
    expect(isSignificantChange(input(), input({ exhaustionScore: 60 }))).toBe('EXHAUSTION_CHANGE');
  });
});

describe('OpenAI provider', () => {
  const SECRET = 'sk-test-SUPERSECRET-123';

  it('sends a strict JSON-schema request with the structured input and parses usage', async () => {
    let captured: { url: string; init: globalThis.RequestInit } | null = null;
    const provider = new OpenAIProvider({ apiKey: SECRET, model: 'test-model', fetcher: (async (url: string, init: globalThis.RequestInit) => {
      captured = { url, init };
      return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 1200, completion_tokens: 150 } }), { status: 200 });
    }) as never });
    const result = await provider.analyzeToken(input());
    expect(result).toMatchObject({ inputTokens: 1200, outputTokens: 150 });
    expect(validateAiTokenAnalysis(result.output).ok).toBe(true);
    const body = JSON.parse(String(captured!.init.body));
    expect(captured!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[1].content).toContain(AI_PROMPT_VERSION);
    expect(body.messages[0].content).toContain('Do not invent missing data');
    // The key is only in the Authorization header, never in the prompt.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('maps HTTP errors without leaking the key', async () => {
    const provider = new OpenAIProvider({ apiKey: SECRET, model: 'test-model', fetcher: (async () => new globalThis.Response('{"error":"bad"}', { status: 429 })) as never });
    const error = await provider.analyzeToken(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).retryable).toBe(true);
    expect(String((error as Error).message)).not.toContain(SECRET);
    const unauthorized = new OpenAIProvider({ apiKey: SECRET, model: 'm', fetcher: (async () => new globalThis.Response('', { status: 401 })) as never });
    expect(((await unauthorized.analyzeToken(input()).catch((caught: unknown) => caught)) as AiProviderError).retryable).toBe(false);
  });

  it('Grok (xAI): same structured request against api.x.ai, health check verifies the model', async () => {
    const calls: string[] = [];
    const provider = new XaiProvider({ apiKey: SECRET, model: 'grok-test', fetcher: (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/models')) return new globalThis.Response(JSON.stringify({ data: [{ id: 'grok-test' }] }), { status: 200 });
      return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer({ decision: 'WATCH' })) } }] }), { status: 200 });
    }) as never });
    expect(provider.getProviderName()).toBe('xai');
    expect(await provider.healthCheck()).toBe(true);
    const result = await provider.analyzeToken(input());
    expect(validateAiTokenAnalysis(result.output)).toMatchObject({ ok: true, analysis: { decision: 'WATCH' } });
    expect(calls).toEqual(['https://api.x.ai/v1/models', 'https://api.x.ai/v1/chat/completions']);
    const missingModel = new XaiProvider({ apiKey: SECRET, model: 'not-listed', fetcher: (async () => new globalThis.Response(JSON.stringify({ data: [{ id: 'grok-test' }] }), { status: 200 })) as never });
    expect(await missingModel.healthCheck()).toBe(false);
  });

  it('Groq (Llama 3): JSON mode with the schema in the prompt, answer still validated server-side', async () => {
    let body: Record<string, unknown> = {};
    const urls: string[] = [];
    const provider = new GroqProvider({ apiKey: SECRET, model: 'llama-3.3-70b-versatile', fetcher: (async (url: string, init: globalThis.RequestInit) => {
      urls.push(url);
      if (url.endsWith('/models')) return new globalThis.Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200 });
      body = JSON.parse(String(init.body));
      return new globalThis.Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(answer({ decision: 'SKIP' }))}\n\`\`\`` } }], usage: { prompt_tokens: 800, completion_tokens: 90 } }), { status: 200 });
    }) as never });
    expect(provider.getProviderName()).toBe('groq');
    expect(await provider.healthCheck()).toBe(true);
    const result = await provider.analyzeToken(input());
    expect(urls).toEqual(['https://api.groq.com/openai/v1/models', 'https://api.groq.com/openai/v1/chat/completions']);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(String((body.messages as Array<{ content: string }>)[0].content)).toContain('"recommendedPositionMultiplier"');
    expect(validateAiTokenAnalysis(result.output)).toMatchObject({ ok: true, analysis: { decision: 'SKIP' } });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('Groq DeepSeek: reasoning hidden; <think> blocks and fences are stripped; free text is rejected', () => {
    const deepseek = new GroqProvider({ apiKey: SECRET, model: 'deepseek-r1-distill-llama-70b' }) as unknown as { requestBody: (value: AiTokenAnalysisInput) => Record<string, unknown> };
    expect(deepseek.requestBody(input()).reasoning_format).toBe('hidden');
    expect(extractJsonObject('<think>hmm</think>\n{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Here: {"a":2} ok')).toEqual({ a: 2 });
    expect(() => extractJsonObject('BUY this token now')).toThrow();
  });

  it('factory-built providers call their own endpoints (no AI_BASE_URL set)', async () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => { urls.push(String(url)); return new globalThis.Response(JSON.stringify({ data: [] }), { status: 200 }); }) as never;
    try {
      await createAiProvider({ AI_PROVIDER: 'groq', GROQ_API_KEY: SECRET }).provider!.healthCheck();
      await createAiProvider({ AI_PROVIDER: 'xai', XAI_API_KEY: SECRET }).provider!.healthCheck();
      await createAiProvider({ AI_PROVIDER: 'openai', OPENAI_API_KEY: SECRET }).provider!.healthCheck();
    } finally {
      globalThis.fetch = original;
    }
    expect(urls).toEqual(['https://api.groq.com/openai/v1/models', 'https://api.x.ai/v1/models', 'https://api.openai.com/v1/models']);
  });

  it('factory: groq uses GROQ_API_KEY and defaults to gpt-oss-120b', () => {
    expect(createAiProvider({ AI_PROVIDER: 'groq' })).toMatchObject({ provider: null, info: { provider: 'groq', model: 'openai/gpt-oss-120b', configured: false } });
    const groq = createAiProvider({ AI_PROVIDER: 'groq', GROQ_API_KEY: SECRET });
    expect(groq.info).toEqual({ provider: 'groq', model: 'openai/gpt-oss-120b', configured: true });
    expect(JSON.stringify(groq.info)).not.toContain(SECRET);
  });

  it('factory: xai/grok uses XAI_API_KEY and never exposes it', () => {
    expect(createAiProvider({ AI_PROVIDER: 'xai' })).toMatchObject({ provider: null, info: { provider: 'xai', configured: false } });
    const grok = createAiProvider({ AI_PROVIDER: 'grok', XAI_API_KEY: SECRET, AI_MODEL: 'grok-test', OPENAI_API_KEY: 'sk-other' });
    expect(grok.info).toEqual({ provider: 'xai', model: 'grok-test', configured: true });
    expect(grok.provider?.getProviderName()).toBe('xai');
    expect(JSON.stringify(grok.info)).not.toContain(SECRET);
  });

  it('factory: no key -> not configured; only safe metadata is exposed', () => {
    expect(createAiProvider({})).toMatchObject({ provider: null, info: { configured: false } });
    expect(createAiProvider({ AI_PROVIDER: 'openai' })).toMatchObject({ provider: null, info: { provider: 'openai', configured: false } });
    const configured = createAiProvider({ AI_PROVIDER: 'openai', OPENAI_API_KEY: SECRET, AI_MODEL: 'test-model' });
    expect(configured.info).toEqual({ provider: 'openai', model: 'test-model', configured: true });
    expect(JSON.stringify(configured.info)).not.toContain(SECRET);
  });
});
