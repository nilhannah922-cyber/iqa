/**
 * The machine-readable step format stored in test_cases.step_action.
 * Single source of truth: test case generation validates against it and the
 * execution engine (BUILD_PLAN.md step 10) must import the same list.
 *
 * selector: a CSS selector from the run's page.json. Interactive-element
 *           selectors work for every action that takes one; content selectors
 *           (headings, labels, text blocks) only where content is true.
 * value:    action input; always a string (see each action's note).
 */
export const STEP_ACTIONS = {
  goto: {
    selector: 'none',
    value: 'optional',
    content: false,
    note: 'Open a URL; empty value means the analyzed page URL.',
  },
  click: {
    selector: 'required',
    value: 'none',
    content: false,
    note: 'Click the element.',
  },
  fill: {
    selector: 'required',
    value: 'required',
    content: false,
    note: 'Replace the field content with value. To leave a field empty, simply do not fill it.',
  },
  check: {
    selector: 'required',
    value: 'none',
    content: false,
    note: 'Tick a checkbox or radio.',
  },
  uncheck: {
    selector: 'required',
    value: 'none',
    content: false,
    note: 'Untick a checkbox.',
  },
  select: {
    selector: 'required',
    value: 'required',
    content: false,
    note: 'Choose the option with this label or value in a dropdown.',
  },
  press: {
    selector: 'optional',
    value: 'required',
    content: false,
    note: 'Press a key (Playwright key name, e.g. "Enter", "Tab") on the element, or on the focused element when no selector is given.',
  },
  wait: {
    selector: 'required',
    value: 'required',
    content: true,
    note: 'Wait until the element is visible; value = timeout in ms (max 30000). Fixed pauses are not allowed.',
  },
  expect_visible: {
    selector: 'required',
    value: 'required',
    content: true,
    note: 'value "true" = element is visible, "false" = hidden or absent.',
  },
  expect_text: {
    selector: 'required',
    value: 'required',
    content: true,
    note: "Element's visible text contains value.",
  },
  expect_value: {
    selector: 'required',
    value: 'required',
    content: false,
    note: "Input's current value equals value.",
  },
  expect_checked: {
    selector: 'required',
    value: 'required',
    content: false,
    note: 'value "true" = checked, "false" = not checked.',
  },
  expect_url: {
    selector: 'none',
    value: 'required',
    content: false,
    note: 'Current URL contains value.',
  },
  expect_title: {
    selector: 'none',
    value: 'required',
    content: false,
    note: 'Page title contains value.',
  },
} as const satisfies Record<
  string,
  {
    selector: 'required' | 'optional' | 'none';
    value: 'required' | 'optional' | 'none';
    /** Accepts content (non-interactive text) selectors. */
    content: boolean;
    note: string;
  }
>;

export type StepActionName = keyof typeof STEP_ACTIONS;

export const STEP_ACTION_NAMES = Object.keys(STEP_ACTIONS) as StepActionName[];

export interface StepAction {
  action: StepActionName;
  selector?: string;
  value?: string;
}

/** Selectors a step may use, from the run's page.json. */
export interface AllowedSelectors {
  interactive: Set<string>;
  content: Set<string>;
}

export function isExpectAction(name: StepActionName): boolean {
  return name.startsWith('expect_');
}

const MAX_WAIT_MS = 30_000;

function isActionName(name: unknown): name is StepActionName {
  return typeof name === 'string' && Object.hasOwn(STEP_ACTIONS, name);
}

/**
 * Strictly validates one step action. Empty strings count as absent.
 * Returns the normalized action, or the reason it is invalid.
 */
export function validateStepAction(
  raw: unknown,
  selectors: AllowedSelectors,
): { ok: true; step: StepAction } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'step action is not an object' };
  }
  const { action, selector, value } = raw as Record<string, unknown>;
  if (!isActionName(action)) {
    return { ok: false, reason: `unknown action "${String(action)}"` };
  }
  if (selector !== undefined && typeof selector !== 'string') {
    return { ok: false, reason: 'selector is not a string' };
  }
  if (value !== undefined && typeof value !== 'string') {
    return { ok: false, reason: 'value is not a string' };
  }
  const spec = STEP_ACTIONS[action];
  const sel = selector?.trim() ? selector : undefined;
  const val = value !== undefined && value !== '' ? value : undefined;

  if (spec.selector === 'required' && !sel) {
    return { ok: false, reason: `"${action}" needs a selector` };
  }
  if (spec.selector === 'none' && sel) {
    return { ok: false, reason: `"${action}" does not take a selector` };
  }
  if (sel && !selectors.interactive.has(sel)) {
    if (!selectors.content.has(sel)) {
      return { ok: false, reason: `selector not in page.json: ${sel}` };
    }
    if (!spec.content) {
      return {
        ok: false,
        reason: `"${action}" needs an interactive element, not a text block: ${sel}`,
      };
    }
  }
  if (spec.value === 'required' && val === undefined) {
    return { ok: false, reason: `"${action}" needs a value` };
  }
  if (spec.value === 'none' && val !== undefined) {
    return { ok: false, reason: `"${action}" does not take a value` };
  }
  if (
    (action === 'expect_visible' || action === 'expect_checked') &&
    val !== 'true' &&
    val !== 'false'
  ) {
    return { ok: false, reason: `"${action}" value must be "true" or "false"` };
  }
  if (action === 'wait') {
    const ms = Number(val);
    if (!Number.isInteger(ms) || ms < 1 || ms > MAX_WAIT_MS) {
      return {
        ok: false,
        reason: `"wait" value must be milliseconds between 1 and ${MAX_WAIT_MS}`,
      };
    }
  }
  if (action === 'goto' && val !== undefined && !/^https?:\/\//i.test(val)) {
    return { ok: false, reason: '"goto" value must be an http(s) URL' };
  }

  return {
    ok: true,
    step: {
      action,
      ...(sel && { selector: sel }),
      ...(val !== undefined && { value: val }),
    },
  };
}
