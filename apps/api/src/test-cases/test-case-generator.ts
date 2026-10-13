/**
 * Mode 1, step 8: test case generation (BUILD_PLAN.md).
 *
 * Asks Claude to turn approved checklist items into step-level test cases
 * (PROJECT_SPEC.md Section 5) with a machine-readable step_action per step,
 * then validates every step strictly against page.json.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { PageAnalysis } from '../analysis/analyze-page';
import {
  ClaudeError,
  ClaudeJsonClient,
  pageSelectors,
  screenshotBlock,
} from '../claude/claude-json';
import {
  STEP_ACTIONS,
  STEP_ACTION_NAMES,
  StepAction,
  StepActionName,
  isExpectAction,
  validateStepAction,
} from './step-actions';

const MAX_TOKENS = 32_000;
/** Review limits: per approved checklist item and per run. */
export const MAX_CASES_PER_ITEM = 3;
export const MAX_CASES_TOTAL = 30;
const MAX_STEPS_PER_CASE = 15;

export interface ApprovedItem {
  id: string;
  title: string;
  description: string;
  related_selectors: string[];
}

export interface GeneratedStep {
  step_details: string;
  expected_output: string;
  test_data: string | null;
  step_action: StepAction;
}

export interface GeneratedCase {
  checklist_item_id: string;
  test_page_area: string;
  test_scenario: string;
  steps: GeneratedStep[];
}

export interface GenerationResult {
  cases: GeneratedCase[];
  model: string;
  usage: Anthropic.Beta.BetaUsage;
  warnings: string[];
  /** Claude's reply text, kept so a failed save can preserve it. */
  rawReply: string;
}

function schemaFor(itemIds: string[]) {
  return {
    type: 'object',
    properties: {
      test_cases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            checklist_item_id: { type: 'string', enum: itemIds },
            test_page_area: { type: 'string' },
            test_scenario: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  step_details: { type: 'string' },
                  expected_output: { type: 'string' },
                  test_data: { type: 'string' },
                  action: { type: 'string', enum: STEP_ACTION_NAMES },
                  selector: { type: 'string' },
                  value: { type: 'string' },
                },
                required: [
                  'step_details',
                  'expected_output',
                  'test_data',
                  'action',
                  'selector',
                  'value',
                ],
                additionalProperties: false,
              },
            },
          },
          required: [
            'checklist_item_id',
            'test_page_area',
            'test_scenario',
            'steps',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['test_cases'],
    additionalProperties: false,
  };
}

function selectorKinds(spec: (typeof STEP_ACTIONS)[StepActionName]): string {
  if (spec.selector === 'none') return '';
  if (spec.content === true) return ' (interactive or content)';
  if (spec.content === 'label') return ' (interactive, or a content label)';
  return ' (interactive only)';
}

export const ACTION_REFERENCE = Object.entries(STEP_ACTIONS)
  .map(
    ([name, spec]) =>
      `- ${name}: selector ${spec.selector}${selectorKinds(spec)}, value ${spec.value}. ${spec.note}`,
  )
  .join('\n');

const SYSTEM_PROMPT = `You are a senior QA engineer writing functional test cases for one web page.
You receive a screenshot of the page, page.json and the approved checklist items. page.json lists the page's interactive elements under "elements" and its visible text blocks (headings, labels, paragraphs, list items) under "content", each with a CSS selector.

Write test cases for the approved checklist items only. Each test case is a sequence of steps that an automated Playwright runner will execute exactly as written, with no AI at run time.

Coverage:
- For each checklist item, write the happy path plus the obvious negative or edge cases. Use 1 to ${MAX_CASES_PER_ITEM} cases per item (never more); prefer fewer, sharper cases over many similar ones. Keep the whole set small enough for a person to review (at most ${MAX_CASES_TOTAL} cases).
- For a form, include at least one negative case (invalid or empty input) when the checklist item is about input, validation or submission.
- Every case must contain at least one expect_* step that verifies what its checklist item is about. A case that only performs actions is not a test.
- Do not repeat a check that another case in this set already covers; give each case a distinct purpose.
- Each case is independent: start with a "goto" step (empty value means the analyzed page URL).
- Keep cases short (at most ${MAX_STEPS_PER_CASE} steps).

Each case:
- checklist_item_id: the id of the checklist item it covers.
- test_page_area: where on the page, e.g. "Order form > Pizza size".
- test_scenario: one line describing the scenario, e.g. "Submit the order with an invalid e-mail address".

Each step:
- step_details: the exact action in plain English for a human reader.
- expected_output: what should be true after this step.
- test_data: only data typed or selected in this step (the same text as a fill or select value). Use "" for checks, clicks and navigation.
- action, selector, value: the machine-readable step. Use "" for selector or value when the action does not take one.
  Allowed actions:
${ACTION_REFERENCE}
- Use only selectors that appear in page.json, copied exactly. Prefer the checklist item's related_selectors. Content selectors are only for expect_visible, expect_text and wait; click also accepts a content selector whose tag is "label".
- Do not add fixed pauses: expect_* steps retry until they pass or time out. Use wait only to wait for a specific element to appear.
- For focus and keyboard checks, use expect_focused on the element that should (or should not) have focus. Never infer which field has focus by typing text and checking where it landed.
- Verify outcomes with expect_* steps. Only assert things you can observe on this page or in its URL/title; do not assume server responses, pages or messages you cannot see.
- Do not include results, bug ids, severities or screenshots.`;

/**
 * Validates Claude's reply. Structural problems throw. An invalid action step
 * (anything that is not expect_*) drops its whole case, because the remaining
 * steps would test something else. Invalid expect_* steps are dropped one by
 * one; a case left with no expect_* step is dropped. Cases over the per-item
 * or total cap are dropped. Every drop is reported as a warning.
 */
export function validateGeneratedCases(
  raw: unknown,
  analysis: PageAnalysis,
  items: ApprovedItem[],
): { cases: GeneratedCase[]; warnings: string[] } {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('test_cases' in raw) ||
    !Array.isArray(raw.test_cases)
  ) {
    throw new ClaudeError('Claude returned JSON without a "test_cases" array.');
  }

  const known = pageSelectors(analysis);
  const itemIds = new Set(items.map((i) => i.id));
  const perItem = new Map<string, number>();
  const warnings: string[] = [];
  const cases: GeneratedCase[] = [];
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  (raw.test_cases as unknown[]).forEach((rawCase, ci) => {
    const label = `Case ${ci + 1}`;
    if (typeof rawCase !== 'object' || rawCase === null) {
      warnings.push(`${label}: dropped, not an object.`);
      return;
    }
    const c = rawCase as Record<string, unknown>;
    const scenario = text(c.test_scenario);
    const name = scenario ? `${label} ("${scenario}")` : label;
    const itemId = text(c.checklist_item_id);
    if (!itemIds.has(itemId)) {
      warnings.push(`${name}: dropped, unknown checklist item "${itemId}".`);
      return;
    }
    if (!scenario || !text(c.test_page_area)) {
      warnings.push(`${name}: dropped, missing scenario or page area.`);
      return;
    }
    const count = perItem.get(itemId) ?? 0;
    if (count >= MAX_CASES_PER_ITEM) {
      warnings.push(
        `${name}: dropped, more than ${MAX_CASES_PER_ITEM} cases for one checklist item.`,
      );
      return;
    }
    if (cases.length >= MAX_CASES_TOTAL) {
      warnings.push(
        `${name}: dropped, over the ${MAX_CASES_TOTAL}-case limit.`,
      );
      return;
    }

    const rawSteps = Array.isArray(c.steps) ? (c.steps as unknown[]) : [];
    if (rawSteps.length > MAX_STEPS_PER_CASE) {
      warnings.push(
        `${name}: dropped, ${rawSteps.length} steps (more than ${MAX_STEPS_PER_CASE}).`,
      );
      return;
    }

    const steps: GeneratedStep[] = [];
    const stepWarnings: string[] = [];
    let actionProblem: string | undefined;
    for (const [si, rawStep] of rawSteps.entries()) {
      const where = `step ${si + 1}`;
      const s =
        typeof rawStep === 'object' && rawStep !== null
          ? (rawStep as Record<string, unknown>)
          : {};
      // Anything not clearly an expect_* step counts as an action step.
      const isExpect =
        typeof s.action === 'string' && s.action.startsWith('expect_');
      const details = text(s.step_details);
      const expected = text(s.expected_output);
      let problem: string | undefined;
      let step: StepAction | undefined;
      if (typeof rawStep !== 'object' || rawStep === null) {
        problem = 'not an object';
      } else if (!details || !expected) {
        problem = 'missing step details or expected output';
      } else {
        const check = validateStepAction(
          { action: s.action, selector: s.selector, value: s.value },
          known,
        );
        if (check.ok) step = check.step;
        else problem = check.reason;
      }

      if (problem !== undefined) {
        if (!isExpect) {
          actionProblem = `${where} (${String(s.action)}) is invalid: ${problem}`;
          break;
        }
        stepWarnings.push(`${name} ${where}: dropped, ${problem}.`);
        continue;
      }
      steps.push({
        step_details: details,
        expected_output: expected,
        test_data: text(s.test_data) || null,
        step_action: step!,
      });
    }

    if (actionProblem !== undefined) {
      warnings.push(`${name}: dropped, action ${actionProblem}.`);
      return;
    }
    warnings.push(...stepWarnings);
    if (steps.length === 0) {
      warnings.push(`${name}: dropped, no valid steps left.`);
      return;
    }
    if (!steps.some((s) => isExpectAction(s.step_action.action))) {
      warnings.push(`${name}: dropped, no expect_* step left to verify it.`);
      return;
    }
    perItem.set(itemId, count + 1);
    cases.push({
      checklist_item_id: itemId,
      test_page_area: text(c.test_page_area),
      test_scenario: scenario,
      steps,
    });
  });

  if (cases.length === 0) {
    throw new ClaudeError(
      `Claude returned no usable test cases. ${warnings.join(' ')}`.trim(),
    );
  }
  return { cases, warnings };
}

export class TestCaseGenerator {
  private readonly claude = new ClaudeJsonClient();

  get model(): string {
    return this.claude.model;
  }

  async generate(
    analysis: PageAnalysis,
    screenshot: Buffer,
    items: ApprovedItem[],
  ): Promise<GenerationResult> {
    const warnings: string[] = [];
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    const image = screenshotBlock(screenshot);
    if ('block' in image) content.push(image.block);
    else warnings.push(image.warning);
    content.push(
      {
        type: 'text',
        text: `page.json:\n${JSON.stringify(analysis, null, 2)}`,
      },
      {
        type: 'text',
        text: `Approved checklist items:\n${JSON.stringify(items, null, 2)}`,
      },
    );

    const reply = await this.claude.requestJson({
      system: SYSTEM_PROMPT,
      content,
      schema: schemaFor(items.map((i) => i.id)),
      maxTokens: MAX_TOKENS,
    });
    let validated: ReturnType<typeof validateGeneratedCases>;
    try {
      validated = validateGeneratedCases(reply.parsed, analysis, items);
    } catch (err) {
      // Keep the paid reply attached so the caller can preserve it.
      throw new ClaudeError(
        err instanceof Error ? err.message : String(err),
        reply,
      );
    }
    return {
      cases: validated.cases,
      model: reply.model,
      usage: reply.usage,
      warnings: [...warnings, ...validated.warnings],
      rawReply: reply.rawReply,
    };
  }
}
