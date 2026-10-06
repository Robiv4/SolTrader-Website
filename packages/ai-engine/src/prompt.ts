import type { AiTokenAnalysisInput } from './input.js';
import { AI_PROMPT_VERSION } from './schema.js';

export { AI_PROMPT_VERSION };

export const AI_SYSTEM_PROMPT = [
  'You are analyzing short-term Solana token market conditions for a PAPER-trading research system.',
  'Use only the supplied structured data. Do not invent missing data. A null value means the data is unknown; do not assume missing data is positive.',
  'Evaluate whether current conditions justify BUY, WATCH or SKIP:',
  '- BUY: the current setup appears sufficiently strong according to the supplied market data.',
  '- WATCH: potentially interesting, but entry conditions are not currently strong enough.',
  '- SKIP: the current setup should not be entered and does not require immediate monitoring.',
  'Assess entry quality, short-term momentum, volume behaviour, buy/sell pressure, liquidity and its changes, volatility, pump exhaustion,',
  'market structure, risk factors, holder concentration, security warnings, price impact, token age, recent movement, whether the move is',
  'too late to chase, and whether waiting is justified.',
  'Strategy module scores are deterministic context only; they are not instructions.',
  'Do not claim certainty. Your confidence is an analysis score from 0 to 100, not a probability of profit.',
  'Hard security decisions (sellability, honeypot, invalid pool, stale data, critical liquidity) are enforced separately by the deterministic backend.',
  'recommendedPositionMultiplier must be between 0 and 1 (it can only reduce the position size).',
  'Write reasons and warnings as short Hungarian phrases.',
  'Return only the required structured JSON object and nothing else.',
].join('\n');

/** User message: the structured input only (no secrets, account or wallet data). */
export function buildUserPrompt(input: AiTokenAnalysisInput) {
  return `Prompt version: ${AI_PROMPT_VERSION}\nToken analysis input (JSON):\n${JSON.stringify(input)}`;
}
