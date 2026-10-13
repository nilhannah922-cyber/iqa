/**
 * Step 9b: edit operations on a run's test case sheet.
 *
 * Pure logic (no database, no Claude): parse and validate operations against
 * the current sheet and page.json, simulate them, build a before/after diff,
 * and fingerprint the sheet so a stale proposal can be refused.
 *
 * Step numbers in operations always refer to the sheet as it was sent, not to
 * positions after earlier operations; renumbering happens once at the end.
 */
import { createHash } from 'node:crypto';
import {
  AllowedSelectors,
  StepAction,
  isExpectAction,
  validateStepAction,
} from './step-actions';

export type ArtifactSource = 'scan' | 'user_note' | 'cross_check';

export interface SheetStep {
  step_details: string;
  expected_output: string;
  test_data: string | null;
  qa_comments: string | null;
  step_action: StepAction;
}

export interface SheetCase {
  test_case_number: string;
  test_page_area: string;
  test_scenario: string;
  checklist_item_id: string | null;
  source: ArtifactSource | null;
  /** Has execution results: may not be changed. */
  executed: boolean;
  steps: (SheetStep & { test_step_number: number })[];
}

export const EDIT_OPS = [
  'update_fields',
  'update_step',
  'add_step',
  'delete_step',
  'add_case',
  'delete_case',
] as const;
export type EditOpName = (typeof EDIT_OPS)[number];

export type EditOperation = { reason?: string } & (
  | {
      op: 'update_fields';
      test_case_number: string;
      test_page_area?: string;
      test_scenario?: string;
    }
  | {
      op: 'update_step';
      test_case_number: string;
      step_number: number;
      step: SheetStep;
    }
  | {
      op: 'add_step';
      test_case_number: string;
      /** Insert after this original step number; 0 = before the first step. */
      after_step: number;
      step: SheetStep;
    }
  | { op: 'delete_step'; test_case_number: string; step_number: number }
  | {
      op: 'add_case';
      test_page_area: string;
      test_scenario: string;
      checklist_item_id: string | null;
      steps: SheetStep[];
    }
  | { op: 'delete_case'; test_case_number: string }
);

/** Limits for one instruction. */
export const MAX_OPERATIONS = 40;
const MAX_STEPS_PER_CASE = 15;
const MAX_TEXT = 2000;
const MAX_SHORT_TEXT = 500;

export interface EditContext {
  sheet: SheetCase[];
  selectors: AllowedSelectors;
  /** Checklist items a new case may be linked to (the run's approved items). */
  approvedItemIds: Set<string>;
}

// ---------------------------------------------------------------- parsing

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Normalizes one raw step ({step_details, expected_output, test_data,
 * qa_comments, action, selector, value}) and validates its action.
 */
export function parseStep(
  raw: unknown,
  selectors: AllowedSelectors,
):
  | { ok: true; step: SheetStep }
  | { ok: false; reason: string; isExpect: boolean } {
  const s =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const isExpect =
    typeof s.action === 'string' && s.action.startsWith('expect_');
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'step is not an object', isExpect };
  }
  const details = str(s.step_details);
  const expected = str(s.expected_output);
  if (!details || !expected) {
    return {
      ok: false,
      reason: 'step is missing step details or expected output',
      isExpect,
    };
  }
  if (details.length > MAX_TEXT || expected.length > MAX_TEXT) {
    return { ok: false, reason: 'step text is too long', isExpect };
  }
  // step_action may come nested ({step_action: {...}}) or flat (action, ...).
  const actionSource =
    typeof s.step_action === 'object' && s.step_action !== null
      ? (s.step_action as Record<string, unknown>)
      : s;
  const check = validateStepAction(
    {
      action: actionSource.action,
      selector: actionSource.selector,
      value: actionSource.value,
    },
    selectors,
  );
  if (!check.ok) return { ok: false, reason: check.reason, isExpect };
  return {
    ok: true,
    step: {
      step_details: details,
      expected_output: expected,
      test_data: str(s.test_data).slice(0, MAX_TEXT) || null,
      qa_comments: str(s.qa_comments).slice(0, MAX_TEXT) || null,
      step_action: check.step,
    },
  };
}

/**
 * Validates raw operations (e.g. from Claude) against the sheet. Invalid
 * operations are dropped with a warning; an invalid action step drops its
 * whole operation, an invalid expect_* step in a new case is dropped alone.
 * Finally every changed or new case must keep at least one step and one
 * expect_* step, otherwise all operations on that case are dropped.
 */
export function validateOperations(
  rawOps: unknown[],
  ctx: EditContext,
): { operations: EditOperation[]; warnings: string[] } {
  const warnings: string[] = [];
  const byNumber = new Map(ctx.sheet.map((c) => [c.test_case_number, c]));
  const ops: EditOperation[] = [];
  /** Label of each kept operation, using its position in the raw list. */
  const labels = new Map<EditOperation, string>();

  if (rawOps.length > MAX_OPERATIONS) {
    warnings.push(
      `Only the first ${MAX_OPERATIONS} of ${rawOps.length} operations were considered.`,
    );
  }

  rawOps.slice(0, MAX_OPERATIONS).forEach((raw, i) => {
    const label = `Operation ${i + 1}`;
    if (typeof raw !== 'object' || raw === null) {
      warnings.push(`${label}: dropped, not an object.`);
      return;
    }
    const o = raw as Record<string, unknown>;
    const op = str(o.op) as EditOpName;
    const reason = str(o.reason).slice(0, MAX_SHORT_TEXT) || undefined;
    const name = `${label} (${op || 'unknown'}${str(o.test_case_number) ? ` ${str(o.test_case_number)}` : ''})`;
    const drop = (why: string) => warnings.push(`${name}: dropped, ${why}.`);
    const keep = (operation: EditOperation) => {
      ops.push(operation);
      labels.set(operation, name);
    };

    if (!EDIT_OPS.includes(op)) return drop(`unknown operation "${op}"`);

    if (op === 'add_case') {
      const area = str(o.test_page_area);
      const scenario = str(o.test_scenario);
      if (!area || !scenario)
        return drop('a new case needs a page area and a scenario');
      if (area.length > 200 || scenario.length > MAX_SHORT_TEXT) {
        return drop('page area or scenario is too long');
      }
      const itemId = str(o.checklist_item_id) || null;
      if (itemId && !ctx.approvedItemIds.has(itemId)) {
        return drop(`unknown or unapproved checklist item "${itemId}"`);
      }
      const rawSteps = Array.isArray(o.steps) ? (o.steps as unknown[]) : [];
      if (rawSteps.length === 0) return drop('a new case needs steps');
      if (rawSteps.length > MAX_STEPS_PER_CASE) {
        return drop(`more than ${MAX_STEPS_PER_CASE} steps`);
      }
      const steps: SheetStep[] = [];
      for (const [si, rawStep] of rawSteps.entries()) {
        const parsed = parseStep(rawStep, ctx.selectors);
        if (parsed.ok) {
          steps.push(parsed.step);
          continue;
        }
        if (!parsed.isExpect) {
          return drop(`action step ${si + 1} is invalid: ${parsed.reason}`);
        }
        warnings.push(`${name} step ${si + 1}: dropped, ${parsed.reason}.`);
      }
      keep({
        op,
        test_page_area: area,
        test_scenario: scenario,
        checklist_item_id: itemId,
        steps,
        reason,
      });
      return;
    }

    const number = str(o.test_case_number);
    const target = byNumber.get(number);
    if (!target) return drop(`test case "${number}" is not in this sheet`);
    if (target.executed)
      return drop(`${number} has been executed and cannot be changed`);
    const stepNumbers = new Set(target.steps.map((s) => s.test_step_number));

    switch (op) {
      case 'delete_case':
        keep({ op, test_case_number: number, reason });
        return;
      case 'update_fields': {
        const area = str(o.test_page_area);
        const scenario = str(o.test_scenario);
        if (!area && !scenario) return drop('nothing to change');
        if (area.length > 200 || scenario.length > MAX_SHORT_TEXT) {
          return drop('page area or scenario is too long');
        }
        keep({
          op,
          test_case_number: number,
          ...(area && { test_page_area: area }),
          ...(scenario && { test_scenario: scenario }),
          reason,
        });
        return;
      }
      case 'delete_step':
      case 'update_step': {
        const stepNumber = Number(o.step_number);
        if (!stepNumbers.has(stepNumber)) {
          return drop(`step ${String(o.step_number)} does not exist`);
        }
        if (op === 'delete_step') {
          keep({
            op,
            test_case_number: number,
            step_number: stepNumber,
            reason,
          });
          return;
        }
        const parsed = parseStep(o.step, ctx.selectors);
        if (!parsed.ok) return drop(parsed.reason);
        keep({
          op,
          test_case_number: number,
          step_number: stepNumber,
          step: parsed.step,
          reason,
        });
        return;
      }
      case 'add_step': {
        const after = Number(o.after_step);
        if (!(after === 0 || stepNumbers.has(after))) {
          return drop(`cannot insert after step ${String(o.after_step)}`);
        }
        const parsed = parseStep(o.step, ctx.selectors);
        if (!parsed.ok) return drop(parsed.reason);
        keep({
          op,
          test_case_number: number,
          after_step: after,
          step: parsed.step,
          reason,
        });
        return;
      }
    }
  });

  // Post-conditions on the simulated result; drop every op on a broken case.
  let current = ops;
  for (let round = 0; round < 5; round++) {
    const sim = simulate(ctx.sheet, current);
    warnings.push(...sim.warnings);
    const broken = new Map<string, string>();
    for (const c of sim.cases) {
      if (c.status === 'removed' || c.status === 'unchanged') continue;
      const why =
        c.steps.length === 0
          ? 'would have no steps left (delete the case instead)'
          : !c.steps.some((s) => isExpectAction(s.step.step_action.action))
            ? 'would have no expect_* step left'
            : c.steps.length > MAX_STEPS_PER_CASE
              ? `would have more than ${MAX_STEPS_PER_CASE} steps`
              : null;
      if (why) broken.set(c.key, why);
    }
    if (broken.size === 0) {
      current = sim.effective;
      break;
    }
    current = current.filter((op, i) => {
      const key = opKey(op, i);
      const why = broken.get(key);
      if (why) {
        warnings.push(
          `${labels.get(op) ?? describeOp(op, i)}: dropped, because ${key.startsWith('new:') ? 'the new case' : key} ${why}.`,
        );
      }
      return !why;
    });
  }
  return { operations: current, warnings: dedupe(warnings) };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function opKey(op: EditOperation, index: number): string {
  return op.op === 'add_case' ? `new:${index}` : op.test_case_number;
}

function describeOp(op: EditOperation, index: number): string {
  return `Operation ${index + 1} (${op.op}${op.op === 'add_case' ? '' : ` ${op.test_case_number}`})`;
}

// ------------------------------------------------------------- simulation

interface SimStep {
  /** Original step number, or null for an inserted step. */
  orig: number | null;
  /** For inserted steps: the original step it was inserted after. */
  insertedAfter: number | null;
  step: SheetStep;
  deleted: boolean;
  changed: boolean;
  reasons: string[];
}

export interface SimCase {
  /** Existing case number, or "new:<op index>" for an added case. */
  key: string;
  status: 'unchanged' | 'changed' | 'removed' | 'added';
  before: SheetCase | null;
  test_page_area: string;
  test_scenario: string;
  checklist_item_id: string | null;
  source: ArtifactSource | null;
  steps: { orig: number | null; step: SheetStep; changed: boolean }[];
  reasons: string[];
}

/**
 * Applies operations to a copy of the sheet. Operations that no longer make
 * sense (e.g. a step of an already deleted case) are skipped with a warning.
 * Returns the resulting cases (deleted steps removed) and the operations that
 * actually took effect.
 */
export function simulate(
  sheet: SheetCase[],
  ops: EditOperation[],
): { cases: SimCase[]; effective: EditOperation[]; warnings: string[] } {
  const warnings: string[] = [];
  const effective: EditOperation[] = [];
  const work = new Map<
    string,
    {
      before: SheetCase;
      area: string;
      scenario: string;
      deleted: boolean;
      touched: boolean;
      steps: SimStep[];
      reasons: string[];
    }
  >();
  for (const c of sheet) {
    work.set(c.test_case_number, {
      before: c,
      area: c.test_page_area,
      scenario: c.test_scenario,
      deleted: false,
      touched: false,
      reasons: [],
      steps: c.steps.map((s) => ({
        orig: s.test_step_number,
        insertedAfter: null,
        step: {
          step_details: s.step_details,
          expected_output: s.expected_output,
          test_data: s.test_data,
          qa_comments: s.qa_comments,
          step_action: s.step_action,
        },
        deleted: false,
        changed: false,
        reasons: [],
      })),
    });
  }
  const added: SimCase[] = [];

  ops.forEach((op, i) => {
    const skip = (why: string) =>
      warnings.push(`${describeOp(op, i)}: skipped, ${why}.`);
    if (op.op === 'add_case') {
      added.push({
        key: `new:${i}`,
        status: 'added',
        before: null,
        test_page_area: op.test_page_area,
        test_scenario: op.test_scenario,
        checklist_item_id: op.checklist_item_id,
        source: 'user_note',
        steps: op.steps.map((step) => ({ orig: null, step, changed: true })),
        reasons: op.reason ? [op.reason] : [],
      });
      effective.push(op);
      return;
    }
    const w = work.get(op.test_case_number);
    if (!w) return skip('unknown test case');
    if (w.deleted) return skip(`${op.test_case_number} is already deleted`);
    if (op.reason) w.reasons.push(op.reason);

    if (op.op === 'delete_case') {
      w.deleted = true;
      w.touched = true;
      effective.push(op);
      return;
    }
    if (op.op === 'update_fields') {
      if (op.test_page_area) w.area = op.test_page_area;
      if (op.test_scenario) w.scenario = op.test_scenario;
      w.touched = true;
      effective.push(op);
      return;
    }
    if (op.op === 'add_step') {
      let index: number;
      if (op.after_step === 0) {
        index = 0;
        while (
          index < w.steps.length &&
          w.steps[index].orig === null &&
          w.steps[index].insertedAfter === 0
        ) {
          index++;
        }
      } else {
        index = w.steps.findIndex((s) => s.orig === op.after_step) + 1;
        if (index === 0) return skip(`step ${op.after_step} not found`);
        while (
          index < w.steps.length &&
          w.steps[index].orig === null &&
          w.steps[index].insertedAfter === op.after_step
        ) {
          index++;
        }
      }
      w.steps.splice(index, 0, {
        orig: null,
        insertedAfter: op.after_step,
        step: op.step,
        deleted: false,
        changed: true,
        reasons: op.reason ? [op.reason] : [],
      });
      w.touched = true;
      effective.push(op);
      return;
    }
    const target = w.steps.find((s) => s.orig === op.step_number);
    if (!target) return skip(`step ${op.step_number} not found`);
    if (target.deleted)
      return skip(`step ${op.step_number} is already deleted`);
    if (op.op === 'delete_step') {
      target.deleted = true;
    } else {
      target.step = op.step;
      target.changed = true;
    }
    w.touched = true;
    effective.push(op);
  });

  const cases: SimCase[] = [];
  for (const [key, w] of work) {
    const steps = w.steps
      .filter((s) => !s.deleted)
      .map((s) => ({ orig: s.orig, step: s.step, changed: s.changed }));
    cases.push({
      key,
      status: w.deleted ? 'removed' : w.touched ? 'changed' : 'unchanged',
      before: w.before,
      test_page_area: w.area,
      test_scenario: w.scenario,
      checklist_item_id: w.before.checklist_item_id,
      source: w.before.source,
      steps,
      reasons: w.reasons,
    });
  }
  return { cases: [...cases, ...added], effective, warnings };
}

// ------------------------------------------------------------------- diff

export interface FieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface StepDiff {
  status: 'added' | 'removed' | 'changed';
  /** Step number before the edit (null for an added step). */
  step_before: number | null;
  /** Step number after the edit (null for a removed step). */
  step_after: number | null;
  /** Full step for added/removed steps. */
  step?: SheetStep;
  /** Changed fields for changed steps. */
  changes?: FieldChange[];
}

export interface CaseDiff {
  status: 'added' | 'removed' | 'changed';
  /** Existing number, or null for a new case (numbered when applied). */
  test_case_number: string | null;
  label: string;
  test_page_area: string;
  test_scenario: string;
  checklist_item_id: string | null;
  fields: FieldChange[];
  steps: StepDiff[];
  reasons: string[];
}

export interface SheetDiff {
  cases: CaseDiff[];
  summary: {
    cases_added: number;
    cases_removed: number;
    cases_changed: number;
    steps_added: number;
    steps_removed: number;
    steps_changed: number;
  };
}

const STEP_FIELDS = [
  'step_details',
  'expected_output',
  'test_data',
  'qa_comments',
] as const;

/** Key-order-independent text of a step action (JSONB reorders keys). */
const actionText = (a: StepAction) =>
  JSON.stringify({
    action: a.action,
    ...(a.selector !== undefined && { selector: a.selector }),
    ...(a.value !== undefined && { value: a.value }),
  });

function stepChanges(before: SheetStep, after: SheetStep): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of STEP_FIELDS) {
    if ((before[field] ?? null) !== (after[field] ?? null)) {
      changes.push({
        field,
        before: before[field] ?? null,
        after: after[field] ?? null,
      });
    }
  }
  if (actionText(before.step_action) !== actionText(after.step_action)) {
    changes.push({
      field: 'step_action',
      before: actionText(before.step_action),
      after: actionText(after.step_action),
    });
  }
  return changes;
}

/** Before/after diff of the simulated result, listing only what changes. */
export function buildDiff(sheet: SheetCase[], ops: EditOperation[]): SheetDiff {
  const { cases } = simulate(sheet, ops);
  const out: CaseDiff[] = [];
  let newIndex = 0;
  for (const c of cases) {
    if (c.status === 'unchanged') continue;
    if (c.status === 'added') {
      newIndex++;
      out.push({
        status: 'added',
        test_case_number: null,
        label: `New case ${newIndex}`,
        test_page_area: c.test_page_area,
        test_scenario: c.test_scenario,
        checklist_item_id: c.checklist_item_id,
        fields: [],
        steps: c.steps.map((s, i) => ({
          status: 'added',
          step_before: null,
          step_after: i + 1,
          step: s.step,
        })),
        reasons: c.reasons,
      });
      continue;
    }
    const before = c.before!;
    if (c.status === 'removed') {
      out.push({
        status: 'removed',
        test_case_number: before.test_case_number,
        label: before.test_case_number,
        test_page_area: before.test_page_area,
        test_scenario: before.test_scenario,
        checklist_item_id: before.checklist_item_id,
        fields: [],
        steps: before.steps.map((s) => ({
          status: 'removed',
          step_before: s.test_step_number,
          step_after: null,
          step: stripNumber(s),
        })),
        reasons: c.reasons,
      });
      continue;
    }
    const fields: FieldChange[] = [];
    if (c.test_page_area !== before.test_page_area) {
      fields.push({
        field: 'test_page_area',
        before: before.test_page_area,
        after: c.test_page_area,
      });
    }
    if (c.test_scenario !== before.test_scenario) {
      fields.push({
        field: 'test_scenario',
        before: before.test_scenario,
        after: c.test_scenario,
      });
    }
    const steps: StepDiff[] = [];
    const kept = new Set<number>();
    c.steps.forEach((s, i) => {
      if (s.orig === null) {
        steps.push({
          status: 'added',
          step_before: null,
          step_after: i + 1,
          step: s.step,
        });
        return;
      }
      kept.add(s.orig);
      const original = before.steps.find((b) => b.test_step_number === s.orig)!;
      const changes = stepChanges(stripNumber(original), s.step);
      if (changes.length) {
        steps.push({
          status: 'changed',
          step_before: s.orig,
          step_after: i + 1,
          changes,
        });
      }
    });
    for (const b of before.steps) {
      if (!kept.has(b.test_step_number)) {
        steps.push({
          status: 'removed',
          step_before: b.test_step_number,
          step_after: null,
          step: stripNumber(b),
        });
      }
    }
    steps.sort(
      (a, b) =>
        (a.step_after ?? a.step_before ?? 0) -
        (b.step_after ?? b.step_before ?? 0),
    );
    if (fields.length === 0 && steps.length === 0) continue;
    out.push({
      status: 'changed',
      test_case_number: before.test_case_number,
      label: before.test_case_number,
      test_page_area: c.test_page_area,
      test_scenario: c.test_scenario,
      checklist_item_id: before.checklist_item_id,
      fields,
      steps,
      reasons: c.reasons,
    });
  }

  const count = (status: StepDiff['status']) =>
    out.reduce(
      (n, c) => n + c.steps.filter((s) => s.status === status).length,
      0,
    );
  return {
    cases: out,
    summary: {
      cases_added: out.filter((c) => c.status === 'added').length,
      cases_removed: out.filter((c) => c.status === 'removed').length,
      cases_changed: out.filter((c) => c.status === 'changed').length,
      steps_added: count('added'),
      steps_removed: count('removed'),
      steps_changed: count('changed'),
    },
  };
}

function stripNumber(s: SheetStep & { test_step_number?: number }): SheetStep {
  return {
    step_details: s.step_details,
    expected_output: s.expected_output,
    test_data: s.test_data,
    qa_comments: s.qa_comments,
    step_action: s.step_action,
  };
}

// ---------------------------------------------------------------- version

/**
 * Fingerprint of the whole sheet of a run (all cases, including whether they
 * were executed). Any edit, deletion, regeneration or new execution result
 * changes it.
 */
export function sheetVersion(sheet: SheetCase[]): string {
  const canonical = [...sheet]
    .sort((a, b) => a.test_case_number.localeCompare(b.test_case_number))
    .map((c) => [
      c.test_case_number,
      c.test_page_area,
      c.test_scenario,
      c.checklist_item_id,
      c.source,
      c.executed,
      [...c.steps]
        .sort((a, b) => a.test_step_number - b.test_step_number)
        .map((s) => [
          s.test_step_number,
          s.step_details,
          s.expected_output,
          s.test_data,
          s.qa_comments,
          actionText(s.step_action),
        ]),
    ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
