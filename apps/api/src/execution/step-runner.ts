/**
 * Step 10: deterministic execution of one test case in Playwright.
 *
 * Every step_action is executed by one switch over the shared STEP_ACTIONS.
 * Selectors and values from the sheet are only ever passed to Playwright as
 * selectors and values; nothing from the sheet is evaluated as code.
 */
import type { Browser, Locator, Page } from 'playwright';
import { STEP_ACTIONS, StepAction } from '../test-cases/step-actions';

export const EXECUTION_LIMITS = {
  /** expect_* steps poll until they pass, up to this long. */
  expectMs: 5_000,
  /** Timeout for action steps (goto, click, fill, ...). */
  actionMs: 10_000,
  /** Overall limit for one test case. */
  caseMs: 60_000,
  pollIntervalMs: 100,
};

export type StepResult = 'pass' | 'fail' | 'not_executed';

export interface ExecStep {
  test_step_number: number;
  step_action: StepAction;
}

export interface ExecCase {
  test_case_number: string;
  steps: ExecStep[];
}

export interface StepOutcome {
  test_step_number: number;
  result: StepResult;
  error: string | null;
  duration_ms: number | null;
}

export interface CaseOutcome {
  steps: StepOutcome[];
  /** Full-page PNG at the first failure, or at the end of the case. */
  screenshot: Buffer | null;
  duration_ms: number;
}

/** A step failure with a message meant for the report. */
export class StepFailure extends Error {}

const MAX_ERROR_LENGTH = 500;

/** First line of a Playwright error, without call logs. */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n').find((l) => l.trim()) ?? raw;
  const text = first.replace(/\s+/g, ' ').trim();
  return text.length > MAX_ERROR_LENGTH
    ? `${text.slice(0, MAX_ERROR_LENGTH)}…`
    : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
const quote = (s: string) => JSON.stringify(s);

/**
 * Runs one case in a fresh browser context. A failed step stops the case:
 * the remaining steps are not executed. Never throws for step failures.
 */
export async function runCase(
  browser: Browser,
  runUrl: string,
  testCase: ExecCase,
  limits = EXECUTION_LIMITS,
): Promise<CaseOutcome> {
  const started = Date.now();
  const deadline = started + limits.caseMs;
  const outcomes: StepOutcome[] = [];
  let screenshot: Buffer | null = null;

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  try {
    const page = await context.newPage();
    let failedStep: number | null = null;

    for (const step of testCase.steps) {
      if (failedStep !== null) {
        outcomes.push({
          test_step_number: step.test_step_number,
          result: 'not_executed',
          error: `Not run: step ${failedStep} failed.`,
          duration_ms: null,
        });
        continue;
      }
      const stepStart = Date.now();
      try {
        const remaining = deadline - stepStart;
        if (remaining <= 0) {
          throw new StepFailure(
            `The case reached its ${limits.caseMs / 1000}s time limit.`,
          );
        }
        await withDeadline(
          runStep(page, runUrl, step.step_action, remaining, limits),
          remaining,
          `The case reached its ${limits.caseMs / 1000}s time limit.`,
        );
        outcomes.push({
          test_step_number: step.test_step_number,
          result: 'pass',
          error: null,
          duration_ms: Date.now() - stepStart,
        });
      } catch (err) {
        failedStep = step.test_step_number;
        outcomes.push({
          test_step_number: step.test_step_number,
          result: 'fail',
          error: cleanError(err),
          duration_ms: Date.now() - stepStart,
        });
        screenshot = await takeScreenshot(page);
      }
    }
    if (failedStep === null) screenshot = await takeScreenshot(page);
  } finally {
    await context.close().catch(() => undefined);
  }
  return { steps: outcomes, screenshot, duration_ms: Date.now() - started };
}

async function takeScreenshot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ fullPage: true, timeout: 10_000 });
  } catch {
    return null;
  }
}

/** Rejects with `message` if `work` does not settle within `ms`. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepFailure(message)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Executes one step. Throws StepFailure (or a Playwright error) on failure. */
export async function runStep(
  page: Page,
  runUrl: string,
  step: StepAction,
  remainingMs: number,
  limits = EXECUTION_LIMITS,
): Promise<void> {
  const action = step.action;
  if (!Object.hasOwn(STEP_ACTIONS, action)) {
    throw new StepFailure(`Unknown action ${quote(String(step.action))}.`);
  }
  const actionTimeout = Math.max(1, Math.min(limits.actionMs, remainingMs));
  const expectTimeout = Math.max(1, Math.min(limits.expectMs, remainingMs));
  const value = step.value ?? '';
  const locator = (): Locator => {
    if (!step.selector) throw new StepFailure(`"${action}" needs a selector.`);
    return page.locator(step.selector);
  };
  /** Runs an action; explains a timeout caused by a missing element. */
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      if (step.selector) {
        const count = await page
          .locator(step.selector)
          .count()
          .catch(() => -1);
        if (count === 0) {
          throw new StepFailure(
            `No element matches ${step.selector} (waited ${Math.round(actionTimeout / 1000)}s).`,
          );
        }
      }
      throw err;
    }
  };

  switch (action) {
    case 'goto': {
      const url = value || runUrl;
      if (!/^https?:\/\//i.test(url)) {
        throw new StepFailure(`Only http and https URLs can be opened: ${url}`);
      }
      let response;
      try {
        response = await page.goto(url, {
          waitUntil: 'load',
          timeout: actionTimeout,
        });
      } catch (err) {
        throw new StepFailure(`Could not load ${url}: ${cleanError(err)}`);
      }
      const status = response?.status();
      if (status !== undefined && status >= 400) {
        throw new StepFailure(`${url} responded with HTTP ${status}.`);
      }
      return;
    }
    case 'click':
      await act(() => locator().click({ timeout: actionTimeout }));
      return;
    case 'fill':
      await act(() => locator().fill(value, { timeout: actionTimeout }));
      return;
    case 'check':
      await act(() => locator().check({ timeout: actionTimeout }));
      return;
    case 'uncheck':
      await act(() => locator().uncheck({ timeout: actionTimeout }));
      return;
    case 'select':
      await act(() =>
        locator().selectOption(value, { timeout: actionTimeout }),
      );
      return;
    case 'press':
      if (step.selector) {
        await act(() => locator().press(value, { timeout: actionTimeout }));
      } else {
        await page.keyboard.press(value);
      }
      return;
    case 'wait': {
      const ms = Math.max(1, Math.min(Number(value) || 0, remainingMs));
      await act(() => locator().waitFor({ state: 'visible', timeout: ms }));
      return;
    }
    case 'expect_visible': {
      const want = value === 'true';
      await poll(
        expectTimeout,
        limits,
        `element ${want ? '' : 'not '}visible`,
        async () => {
          const visible = await single(locator(), true).then((l) =>
            l ? l.isVisible() : false,
          );
          return {
            ok: visible === want,
            observed: visible ? 'visible' : 'not visible',
          };
        },
      );
      return;
    }
    case 'expect_text':
      await poll(
        expectTimeout,
        limits,
        `text containing ${quote(value)}`,
        async () => {
          const l = await single(locator());
          const text = normalize(await l!.innerText({ timeout: 1_000 }));
          return {
            ok: text.includes(normalize(value)),
            observed: quote(text.slice(0, 120)),
          };
        },
      );
      return;
    case 'expect_value':
      // "" means the field must be empty.
      await poll(expectTimeout, limits, `value ${quote(value)}`, async () => {
        const l = await single(locator());
        const current = await l!.inputValue({ timeout: 1_000 });
        return { ok: current === value, observed: quote(current) };
      });
      return;
    case 'expect_checked': {
      const want = value === 'true';
      await poll(
        expectTimeout,
        limits,
        want ? 'checked' : 'not checked',
        async () => {
          const l = await single(locator());
          const checked = await l!.isChecked({ timeout: 1_000 });
          return {
            ok: checked === want,
            observed: checked ? 'checked' : 'not checked',
          };
        },
      );
      return;
    }
    case 'expect_focused': {
      const want = value === 'true';
      await poll(
        expectTimeout,
        limits,
        want ? 'focused' : 'not focused',
        async () => {
          const l = await single(locator());
          // Fixed check written here, never taken from the sheet.
          const focused = await l!.evaluate(
            (el) => el === el.ownerDocument.activeElement,
            undefined,
            { timeout: 1_000 },
          );
          return {
            ok: focused === want,
            observed: focused ? 'focused' : 'not focused',
          };
        },
      );
      return;
    }
    case 'expect_url':
      await poll(
        expectTimeout,
        limits,
        `URL containing ${quote(value)}`,
        () => {
          const url = page.url();
          return Promise.resolve({ ok: url.includes(value), observed: url });
        },
      );
      return;
    case 'expect_title':
      await poll(
        expectTimeout,
        limits,
        `title containing ${quote(value)}`,
        async () => {
          const title = await page.title();
          return { ok: title.includes(value), observed: quote(title) };
        },
      );
      return;
  }
}

/**
 * Resolves a locator to exactly one element. 0 matches: null when
 * `allowMissing`, otherwise a retryable "not found". More than 1 match is a
 * test-case problem and fails at once.
 */
async function single(
  l: Locator,
  allowMissing = false,
): Promise<Locator | null> {
  const count = await l.count();
  if (count === 0) {
    if (allowMissing) return null;
    throw new Retry('element not found');
  }
  if (count > 1) {
    throw new StepFailure(
      `The selector matches ${count} elements, expected exactly one.`,
    );
  }
  return l;
}

/** A probe result that may still change: keep polling. */
class Retry extends Error {}

/** Polls `probe` until it passes or `timeoutMs` elapses (expect-style). */
async function poll(
  timeoutMs: number,
  limits: typeof EXECUTION_LIMITS,
  expected: string,
  probe: () => Promise<{ ok: boolean; observed: string }>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed = 'nothing';
  for (;;) {
    try {
      const r = await probe();
      if (r.ok) return;
      observed = r.observed;
    } catch (err) {
      if (err instanceof StepFailure) throw err;
      // Not found yet, navigation in progress, element detached: retry.
      observed = err instanceof Retry ? err.message : cleanError(err);
    }
    if (Date.now() >= deadline) {
      throw new StepFailure(
        `Expected ${expected} within ${timeoutMs / 1000}s, but got ${observed}.`,
      );
    }
    await sleep(limits.pollIntervalMs);
  }
}
