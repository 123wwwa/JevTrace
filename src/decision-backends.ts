import { setTimeout as delayFor } from 'node:timers/promises';

/**
 * Provider-neutral decision request. Retrieval code (what to ask, batching, caching, score use) is written
 * against this shape; a backend maps it onto one provider's wire format. Adding a decision provider means
 * writing one backend and registering it in `providers` below; nothing in the retrieval pipeline changes.
 */
export type DecisionQuestion =
  /** Answered with a probability in [0, 1] that the statement holds. */
  | { type: 'probability'; instructions: string }
  /** Answered with one key of `options`. */
  | { type: 'choice'; instructions: string; options: Record<string, string> };

export interface DecisionRequest {
  model: string;
  /** Shared context every question is judged against (task, candidates, repository tree, ...). */
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported cost in USD, when the provider returns one. */
  cost?: number;
}

export interface DecisionResult {
  /** Probability in [0, 1] for probability questions, the chosen option key for choice questions; missing when unanswered. */
  answers: Record<string, number | string | undefined>;
  usage?: DecisionUsage;
  /** HTTP attempts, including one retry of a transient failure. */
  attempts: number;
}

export interface DecisionBackend {
  /** Stable identity of the provider route; part of the answer-cache key. */
  readonly cacheKey: string;
  /** The exact request body the backend would send; hashed for the answer cache. */
  serialize(request: DecisionRequest): string;
  decide(request: DecisionRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DecisionResult>;
}

// ---- shared HTTP handling -------------------------------------------------------------------------------

const transientStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status === 500
  || status === 502 || status === 503 || status === 504
  || status === 520 || status === 522 || status === 524;

export async function providerError(response: Response, label = 'Decision request'): Promise<Error> {
  let detail = '';
  try {
    const raw = (await response.text()).trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
        const error = parsed.error && typeof parsed.error === 'object'
          ? parsed.error as Record<string, unknown>
          : undefined;
        const metadata = error?.metadata && typeof error.metadata === 'object'
          ? error.metadata as Record<string, unknown>
          : undefined;
        const message = typeof error?.message === 'string'
          ? error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : raw;
        const limitSource = typeof metadata?.limit_source === 'string'
          ? metadata.limit_source
          : undefined;
        detail = limitSource ? `${message} [limit_source=${limitSource}]` : message;
      } catch {
        detail = raw;
      }
    }
  } catch {
    // Keep the HTTP status even when the provider body cannot be read.
  }

  const fallback = response.status === 402
    ? 'Payment required: check the selected provider credits, billing, or API-key spending limits'
    : response.statusText;
  const suffix = (detail || fallback).replace(/\s+/g, ' ').slice(0, 1000);
  return new Error(`${label} failed (${response.status})${suffix ? `: ${suffix}` : ''}`);
}

/** POSTs JSON with one retry of a transient status or network failure; returns the parsed body. */
export async function postJson(url: string, headers: Record<string, string>, body: string, options: {
  signal?: AbortSignal; timeoutMs?: number; label: string;
}): Promise<{ data: unknown; attempts: number }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let response: Response | undefined;
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal?.throwIfAborted();
    try {
      attempts++;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      lastError = undefined;
      if (!transientStatus(response.status) || attempt === 1) break;
      const rawRetry = response.headers.get('retry-after');
      const seconds = rawRetry === null ? NaN : Number(rawRetry);
      await delayFor(Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 2000) : 500, undefined, { signal: options.signal });
    } catch (error) {
      options.signal?.throwIfAborted();
      lastError = error;
      if (attempt === 1) break;
      await delayFor(250, undefined, { signal: options.signal });
    }
  }
  if (!response) {
    if (lastError instanceof Error) throw new Error(`${options.label} failed after retry: ${lastError.name}: ${lastError.message}`);
    throw new Error(`${options.label} did not return a response`);
  }
  if (!response.ok) throw await providerError(response, options.label);
  return { data: await response.json(), attempts };
}

// ---- Jev (TypeSafe System One wire format; also served by OpenRouter, Vercel AI Gateway, OpenCode Zen) --

interface JevAnswer { probability?: number; value?: boolean | number; noul?: number; choice?: string }

export class JevBackend implements DecisionBackend {
  readonly cacheKey: string;
  constructor(private readonly endpoint: string, private readonly apiKey: string) {
    this.cacheKey = endpoint;
  }

  serialize(request: DecisionRequest): string {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id,
      question.type === 'probability'
        ? { type: 'noul', instructions: question.instructions }
        : { type: 'choice', instructions: question.instructions, criteria: question.options },
    ]));
    return JSON.stringify({ model: request.model, state: request.state, questions });
  }

  async decide(request: DecisionRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DecisionResult> {
    const { data, attempts } = await postJson(this.endpoint, this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      this.serialize(request), { ...options, label: 'Jev request' });
    const body = data as { answers?: Record<string, JevAnswer | number>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
    if (!body.answers) throw new Error('Jev response has no answers');
    const answers: DecisionResult['answers'] = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = body.answers[id];
      if (question.type === 'choice') {
        answers[id] = typeof answer === 'object' && typeof answer?.choice === 'string' ? answer.choice : undefined;
        continue;
      }
      answers[id] = typeof answer === 'number' ? answer
        : typeof answer?.noul === 'number' ? answer.noul
        : typeof answer?.probability === 'number' ? answer.probability
        : typeof answer?.value === 'number' ? answer.value
        : typeof answer?.value === 'boolean' ? Number(answer.value) : undefined;
    }
    const usage = body.usage && { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens, cost: body.usage.cost };
    return { answers, usage, attempts };
  }
}

// ---- provider registry -----------------------------------------------------------------------------------

export interface ProviderSpec {
  /** Environment variable holding the API key (optional for providers that allow keyless endpoints). */
  keyEnv?: string;
  endpoint: string;
  model: string;
  createBackend(config: { endpoint: string; apiKey: string }): DecisionBackend;
}

const jev = (config: { endpoint: string; apiKey: string }) => new JevBackend(config.endpoint, config.apiKey);

/**
 * Decision providers selectable with JEVTRACE_PROVIDER / --provider. To add one (for example another
 * vendor's decisions API): implement DecisionBackend for its wire format and add an entry here.
 */
export const providers = {
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', createBackend: jev },
  typesafe: { keyEnv: 'TYPESAFE_API_KEY', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', createBackend: jev },
  vercel: { keyEnv: 'AI_GATEWAY_API_KEY', endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', createBackend: jev },
  opencode: { keyEnv: 'OPENCODE_API_KEY', endpoint: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13', createBackend: jev },
} satisfies Record<string, ProviderSpec>;
