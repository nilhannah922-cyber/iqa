/**
 * The machine-readable step format stored in test_cases.step_action.
 * Single source of truth: test case generation validates against it and the
 * execution engine (BUILD_PLAN.md step 10) must import the same list.
 *
 * selector: a CSS selector from the run's page.json.
 * value:    action input; always a string (see each action's note).
 */
export const STEP_ACTIONS = {
  goto: {
    selector: 'none',
    value: 'optional',
    note: 'Open a URL; empty value means the analyzed page URL.',
  },
  click: { selector: 'required', value: 'none', note: 'Click the element.' },
  fill: {
    selector: 'required',
    value: 'required',
    note: 'Replace the field content with value. To leave a field empty, simply do not fill it.',
  },
  check: {
    selector: 'required',
    value: 'none',
    note: 'Tick a checkbox or radio.',
  },
  uncheck: { selector: 'required', value: 'none', note: 'Untick a checkbox.' },
  select: {
    selector: 'required',
    value: 'required',
    note: 'Choose the option with this label or value in a dropdown.',
  },
  press: {
    selector: 'optional',
    value: 'required',
    note: 'Press a key (Playwright key name, e.g. "Enter", "Tab") on the element, or on the focused element when no selector is given.',
  },
  wait: {
    selector: 'optional',
    value: 'required',
    note: 'With a selector: wait until it is visible, value = timeout in ms. Without: pause for value ms. Max 30000.',
  },
  expect_visible: {
    selector: 'required',
    value: 'required',
    note: 'value "true" = element is visible, "false" = hidden or absent.',
  },
  expect_text: {
    selector: 'required',
    value: 'required',
    note: "Element's visible text contains value.",
  },
  expect_value: {
    selector: 'required',
    value: 'required',
    note: "Input's current value equals value.",
  },
  expect_checked: {
    selector: 'required',
    value: 'required',
    note: 'value "true" = checked, "false" = not checked.',
  },
  expect_url: {
    selector: 'none',
    value: 'required',
    note: 'Current URL contains value.',
  },
  expect_title: {
    selector: 'none',
    value: 'required',
    note: 'Page title contains value.',
  },
} as const satisfies Record<
  string,
  {
    selector: 'required' | 'optional' | 'none';
    value: 'required' | 'optional' | 'none';
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
  knownSelectors: Set<string>,
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
  if (sel && !knownSelectors.has(sel)) {
    return { ok: false, reason: `selector not in page.json: ${sel}` };
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
