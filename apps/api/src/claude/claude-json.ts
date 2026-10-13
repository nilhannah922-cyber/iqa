/**
 * Shared Claude API setup for features that ask for structured JSON output
 * (checklist generation, test case generation): environment, key check,
 * model choice, refusal fallbacks, screenshot handling and error mapping.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ElementInfo, PageAnalysis } from '../analysis/analyze-page';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const PLACEHOLDER_KEY = 'your-anthropic-api-key';

// The API rejects images over 5 MB or 8000 px on a side.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;

// Models that accept server-side fallbacks: "default" (re-runs a safety-classifier
// refusal on Anthropic's recommended fallback model).
const FALLBACK_MODEL_PREFIXES = [
  'claude-sonnet-5-5',
  'claude-opus-5',
  'claude-fable-5',
];

/** Any failure talking to Claude or understanding its reply. */
export class ClaudeError extends Error {
  /** Claude's raw reply text, when the failure happened after it replied. */
  rawReply?: string;
  model?: string;
  usage?: Anthropic.Beta.BetaUsage;

  constructor(
    message: string,
    reply?: {
      rawReply: string;
      model: string;
      usage: Anthropic.Beta.BetaUsage;
    },
  ) {
    super(message);
    if (reply) Object.assign(this, reply);
  }
}

/** Loads apps/api/.env into process.env if present. Never prints values. */
export function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '..', '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/** Throws if the key is missing or still the placeholder. Never reveals it. */
export function assertApiKeySet(): void {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || key === PLACEHOLDER_KEY) {
    throw new ClaudeError(
      'ANTHROPIC_API_KEY is not set. Add it to apps/api/.env (see .env.example).',
    );
  }
}

/** Every selector listed in page.json. */
export function allSelectors(analysis: PageAnalysis): Set<string> {
  const groups = Object.values(analysis.elements) as ElementInfo[][];
  return new Set(groups.flat().map((el) => el.selector));
}

function pngSize(png: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes), then IHDR: length, type, width, height.
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Image block for the screenshot, or a warning when the API would reject it. */
export function screenshotBlock(
  screenshot: Buffer,
): { block: Anthropic.Beta.BetaImageBlockParam } | { warning: string } {
  const size = pngSize(screenshot);
  if (
    screenshot.length > MAX_IMAGE_BYTES ||
    !size ||
    size.width > MAX_IMAGE_SIDE ||
    size.height > MAX_IMAGE_SIDE
  ) {
    return {
      warning:
        'Screenshot is too large for the API (over 5 MB or 8000 px); sent page.json only.',
    };
  }
  return {
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: screenshot.toString('base64'),
      },
    },
  };
}

export interface JsonReply {
  parsed: unknown;
  /** The reply text exactly as Claude sent it. */
  rawReply: string;
  model: string;
  usage: Anthropic.Beta.BetaUsage;
}

export class ClaudeJsonClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor() {
    assertApiKeySet();
    // Reads ANTHROPIC_API_KEY from the environment; the key is never logged.
    this.client = new Anthropic();
    this.model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  }

  /** Sends one request constrained to the JSON schema and parses the reply. */
  async requestJson(params: {
    system: string;
    content: Anthropic.Beta.BetaContentBlockParam[];
    schema: Record<string, unknown>;
    maxTokens: number;
  }): Promise<JsonReply> {
    const useFallbacks = FALLBACK_MODEL_PREFIXES.some((p) =>
      this.model.startsWith(p),
    );

    let response: Anthropic.Beta.BetaMessage;
    try {
      // Streamed so large outputs don't hit HTTP timeouts.
      response = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: params.maxTokens,
          system: params.system,
          messages: [{ role: 'user', content: params.content }],
          output_config: {
            format: { type: 'json_schema', schema: params.schema },
          },
          ...(useFallbacks && {
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default' as const,
          }),
        })
        .finalMessage();
    } catch (err) {
      throw describeApiError(err);
    }

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      throw new ClaudeError(
        `Claude declined the request (refusal category: ${category}).`,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ClaudeError(
        `Claude's reply hit the ${params.maxTokens}-token limit and was cut off.`,
      );
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const reply = {
      rawReply: text,
      model: response.model,
      usage: response.usage,
    };
    try {
      return { parsed: JSON.parse(text), ...reply };
    } catch {
      throw new ClaudeError(
        'Claude returned a reply that is not valid JSON.',
        reply,
      );
    }
  }
}

function describeApiError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ClaudeError(
      'The Claude API rejected ANTHROPIC_API_KEY (401). Check the key in apps/api/.env.',
    );
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError(
      'The API key does not have access to this model (403).',
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ClaudeError(
      'Model not found (404). Check ANTHROPIC_MODEL in apps/api/.env.',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ClaudeError(
      'Rate limited by the Claude API (429). Try again later.',
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ClaudeError(`Claude API rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ClaudeError('Could not reach the Claude API (network error).');
  }
  if (err instanceof Anthropic.APIError) {
    return new ClaudeError(`Claude API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
