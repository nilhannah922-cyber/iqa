/**
 * Mode 1, step 6: checklist generation (BUILD_PLAN.md).
 *
 * Sends a PageAnalysis (page.json) and its screenshot to Claude and returns a
 * validated functionality checklist. No database writes, no endpoint yet.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ElementInfo, PageAnalysis } from '../analysis/analyze-page';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 16_000;
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

export interface ChecklistItem {
  title: string;
  description: string;
  related_selectors: string[];
}

export interface ChecklistResult {
  items: ChecklistItem[];
  model: string;
  usage: Anthropic.Beta.BetaUsage;
  /** Validation notes, e.g. selectors Claude invented that were removed. */
  warnings: string[];
}

export class ChecklistError extends Error {}

const CHECKLIST_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          related_selectors: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'description', 'related_selectors'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a senior QA engineer planning functional tests for one web page.
You receive a screenshot of the page and page.json, a list of its interactive elements, each with a CSS selector.

Propose a functionality checklist: the distinct behaviours of this page that a functional test suite should cover (e.g. form submission, field validation, required fields, option selection, navigation, links, modals).
- Each item is one testable functionality, not one element. Group related elements into one item.
- title: short, imperative (e.g. "Submit the order form with valid data").
- description: what to verify and the expected behaviour, in one or two sentences.
- related_selectors: the selectors from page.json that the item exercises, copied exactly. Use only selectors that appear in page.json; use an empty array if none apply.
- Cover only what is visible on this page; do not invent features, pages or elements.
- Order items from most to least important for the page's purpose.`;

/** Loads apps/api/.env into process.env if present. Never prints values. */
export function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '..', '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/** Throws if the key is missing or still the placeholder. Never reveals it. */
export function assertApiKeySet(): void {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || key === PLACEHOLDER_KEY) {
    throw new ChecklistError(
      'ANTHROPIC_API_KEY is not set. Add it to apps/api/.env (see .env.example).',
    );
  }
}

function pngSize(png: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes), then IHDR: length, type, width, height.
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function allSelectors(analysis: PageAnalysis): Set<string> {
  const groups = Object.values(analysis.elements) as ElementInfo[][];
  return new Set(groups.flat().map((el) => el.selector));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validates Claude's reply. Structural problems throw; selectors that are not
 * in page.json are removed and reported as warnings.
 */
export function validateChecklist(
  raw: unknown,
  analysis: PageAnalysis,
): { items: ChecklistItem[]; warnings: string[] } {
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) {
    throw new ChecklistError('Claude returned JSON without an "items" array.');
  }
  const items: unknown = raw.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ChecklistError('Claude returned an empty checklist.');
  }

  const known = allSelectors(analysis);
  const warnings: string[] = [];
  const result = items.map((item: unknown, i): ChecklistItem => {
    const n = i + 1;
    if (typeof item !== 'object' || item === null) {
      throw new ChecklistError(`Checklist item ${n} is not an object.`);
    }
    const { title, description, related_selectors } = item as Record<
      string,
      unknown
    >;
    if (typeof title !== 'string' || !title.trim()) {
      throw new ChecklistError(`Checklist item ${n} has no title.`);
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new ChecklistError(`Checklist item ${n} has no description.`);
    }
    if (!isStringArray(related_selectors)) {
      throw new ChecklistError(
        `Checklist item ${n} has an invalid related_selectors list.`,
      );
    }
    const unknownSelectors = related_selectors.filter((s) => !known.has(s));
    if (unknownSelectors.length) {
      warnings.push(
        `Item ${n} ("${title.trim()}"): removed selectors not in page.json: ${unknownSelectors.join(', ')}`,
      );
    }
    return {
      title: title.trim(),
      description: description.trim(),
      related_selectors: [
        ...new Set(related_selectors.filter((s) => known.has(s))),
      ],
    };
  });
  return { items: result, warnings };
}

export class ChecklistService {
  private readonly client: Anthropic;
  readonly model: string;

  constructor() {
    assertApiKeySet();
    // Reads ANTHROPIC_API_KEY from the environment; the key is never logged.
    this.client = new Anthropic();
    this.model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  }

  async generate(
    analysis: PageAnalysis,
    screenshot: Buffer,
  ): Promise<ChecklistResult> {
    const warnings: string[] = [];
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];

    const size = pngSize(screenshot);
    if (
      screenshot.length > MAX_IMAGE_BYTES ||
      !size ||
      size.width > MAX_IMAGE_SIDE ||
      size.height > MAX_IMAGE_SIDE
    ) {
      warnings.push(
        'Screenshot is too large for the API (over 5 MB or 8000 px); sent page.json only.',
      );
    } else {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: screenshot.toString('base64'),
        },
      });
    }
    content.push({
      type: 'text',
      text: `page.json:\n${JSON.stringify(analysis, null, 2)}`,
    });

    const useFallbacks = FALLBACK_MODEL_PREFIXES.some((p) =>
      this.model.startsWith(p),
    );

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        output_config: {
          format: { type: 'json_schema', schema: CHECKLIST_SCHEMA },
        },
        ...(useFallbacks && {
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default' as const,
        }),
      });
    } catch (err) {
      throw describeApiError(err);
    }

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      throw new ChecklistError(
        `Claude declined the request (refusal category: ${category}).`,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ChecklistError(
        `Claude's reply hit the ${MAX_TOKENS}-token limit and was cut off.`,
      );
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ChecklistError(
        'Claude returned a reply that is not valid JSON.',
      );
    }

    const validated = validateChecklist(parsed, analysis);
    return {
      items: validated.items,
      model: response.model,
      usage: response.usage,
      warnings: [...warnings, ...validated.warnings],
    };
  }
}

function describeApiError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ChecklistError(
      'The Claude API rejected ANTHROPIC_API_KEY (401). Check the key in apps/api/.env.',
    );
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ChecklistError(
      'The API key does not have access to this model (403).',
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ChecklistError(
      'Model not found (404). Check ANTHROPIC_MODEL in apps/api/.env.',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ChecklistError(
      'Rate limited by the Claude API (429). Try again later.',
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ChecklistError(
      `Claude API rejected the request: ${err.message}`,
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ChecklistError(
      'Could not reach the Claude API (network error).',
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new ChecklistError(`Claude API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
