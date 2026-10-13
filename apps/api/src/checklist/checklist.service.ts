/**
 * Mode 1, step 6: checklist generation (BUILD_PLAN.md).
 *
 * Sends a PageAnalysis (page.json) and its screenshot to Claude and returns a
 * validated functionality checklist.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { PageAnalysis } from '../analysis/analyze-page';
import {
  ClaudeError,
  ClaudeJsonClient,
  allSelectors,
  screenshotBlock,
} from '../claude/claude-json';

export {
  ClaudeError as ChecklistError,
  DEFAULT_MODEL,
  assertApiKeySet,
  loadEnv,
} from '../claude/claude-json';

const MAX_TOKENS = 16_000;

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
    throw new ClaudeError('Claude returned JSON without an "items" array.');
  }
  const items: unknown = raw.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ClaudeError('Claude returned an empty checklist.');
  }

  const known = allSelectors(analysis);
  const warnings: string[] = [];
  const result = items.map((item: unknown, i): ChecklistItem => {
    const n = i + 1;
    if (typeof item !== 'object' || item === null) {
      throw new ClaudeError(`Checklist item ${n} is not an object.`);
    }
    const { title, description, related_selectors } = item as Record<
      string,
      unknown
    >;
    if (typeof title !== 'string' || !title.trim()) {
      throw new ClaudeError(`Checklist item ${n} has no title.`);
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new ClaudeError(`Checklist item ${n} has no description.`);
    }
    if (!isStringArray(related_selectors)) {
      throw new ClaudeError(
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
  private readonly claude = new ClaudeJsonClient();

  get model(): string {
    return this.claude.model;
  }

  async generate(
    analysis: PageAnalysis,
    screenshot: Buffer,
  ): Promise<ChecklistResult> {
    const warnings: string[] = [];
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];

    const image = screenshotBlock(screenshot);
    if ('block' in image) content.push(image.block);
    else warnings.push(image.warning);
    content.push({
      type: 'text',
      text: `page.json:\n${JSON.stringify(analysis, null, 2)}`,
    });

    const reply = await this.claude.requestJson({
      system: SYSTEM_PROMPT,
      content,
      schema: CHECKLIST_SCHEMA,
      maxTokens: MAX_TOKENS,
    });

    const validated = validateChecklist(reply.parsed, analysis);
    return {
      items: validated.items,
      model: reply.model,
      usage: reply.usage,
      warnings: [...warnings, ...validated.warnings],
    };
  }
}
