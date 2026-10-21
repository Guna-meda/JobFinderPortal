import Anthropic from '@anthropic-ai/sdk';
import { DRAFT_SCHEMA } from './outreach.js';

/** An AI failure reduced to a stable, secret-free code. Never carries the SDK error text, headers or the key. */
export class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
  }
}

const PLACEHOLDER_KEY = /^(your|xxx|changeme|replace|sk-ant-\.\.\.)/i;

function classify(e) {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth');
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate_limited');
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network');
  if (e instanceof Anthropic.BadRequestError) return new ProviderError('bad_request');
  return new ProviderError('provider_error');
}

/**
 * Claude via the official SDK. A short draft needs little reasoning, so effort is low. The reply is constrained
 * to {subject, body} with structured outputs. The API key stays in this server process only.
 */
export function createAnthropicProvider({ apiKey, model = 'claude-opus-5-5', client } = {}) {
  const c = client || new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  return {
    name: 'anthropic',
    model,
    async generate({ system, user }) {
      let res;
      try {
        res = await c.messages.create({
          model,
          max_tokens: 4000,
          system,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
          messages: [{ role: 'user', content: user }],
        });
      } catch (e) {
        throw classify(e);
      }
      if (res.stop_reason === 'refusal') throw new ProviderError('refused');
      if (res.stop_reason === 'max_tokens') throw new ProviderError('truncated');
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) throw new ProviderError('empty');
      return text;
    },
  };
}

/** The provider configured in the environment, or null when no usable key is set (template-only mode). */
export function providerFromEnv(env = process.env) {
  const key = (env.ANTHROPIC_API_KEY || '').trim();
  if (!key || PLACEHOLDER_KEY.test(key) || env.OUTREACH_AI === 'off') return null;
  return createAnthropicProvider({ apiKey: key, model: (env.OUTREACH_AI_MODEL || '').trim() || undefined });
}
