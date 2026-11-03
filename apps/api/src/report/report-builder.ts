/**
 * Step 12: report building blocks shared by all modes (Full Check now; Cross
 * Check and Recheck will add their own sections later). Pure functions, no
 * database: summary counts in CASES and the 12-column per-step sheet.
 *
 * Final result of a case = the user-confirmed result. Unconfirmed cases are
 * "awaiting confirmation" and are never guessed. A case that has no result
 * at all in this run (added to the sheet after the execution) was not run:
 * it counts as not executed, and is also reported as "not_run".
 */
import { caseActualOutputs } from '../results/actual-output';
import { isTestCaseProblem } from '../results/result-rules';

export type StepResult = 'pass' | 'fail' | 'not_executed';
export type ConfirmedResult = StepResult;
export type Severity = 'minor' | 'major' | 'critical';

/** One step row as stored for this run (sheet + its result row). */
export interface ReportStepInput {
  test_case_number: string;
  test_page_area: string;
  test_scenario: string;
  test_step_number: number;
  step_details: string;
  expected_output: string;
  test_data: string | null;
  /** Deterministic result of the step (null if the step has no result row). */
  result: StepResult | null;
  execution_error: string | null;
  user_confirmed_result: ConfirmedResult | null;
  ai_reason: string | null;
  ai_proposed_result: 'pass' | 'fail' | 'not_executed' | null;
  bug_id: string | null;
  bug_severity: Severity | null;
  bug_status: string | null;
  qa_comments: string | null;
  screenshot: string | null;
}

const aiVerdict = (r: string | null) =>
  r === 'pass' || r === 'fail' ? r : null;

/** The sheet columns of PROJECT_SPEC.md Section 5, in spec order. */
export const SHEET_COLUMNS = [
  { key: 'test_case_number', header: 'Test case number' },
  { key: 'test_page_area', header: 'Test page & area' },
  { key: 'test_scenario', header: 'Test scenario' },
  { key: 'test_step_number', header: 'Test step number' },
  { key: 'step_details', header: 'Step details' },
  { key: 'expected_output', header: 'Expected output' },
  { key: 'actual_output', header: 'Actual output' },
  { key: 'test_data', header: 'Test data' },
  { key: 'result', header: 'Result' },
  { key: 'bug_id', header: 'Bug ID' },
  { key: 'screenshot', header: 'Screenshot' },
  { key: 'qa_comments', header: 'QA comments' },
  { key: 'bug_severity', header: 'Bug severity' },
] as const;

export type SheetRow = {
  test_case_number: string;
  test_page_area: string;
  test_scenario: string;
  test_step_number: number;
  step_details: string;
  expected_output: string;
  /** What actually happened in this run (see results/actual-output.ts). */
  actual_output: string | null;
  test_data: string | null;
  /** Per-step result from this run's execution. */
  result: StepResult;
  bug_id: string | null;
  /** Storage key of the case screenshot. */
  screenshot: string | null;
  qa_comments: string | null;
  bug_severity: Severity | null;
  /** Not one of the 12 columns: the confirmed result of the whole case. */
  confirmed_case_result: ConfirmedResult | null;
  /** The step has no result in this run (case added after the execution). */
  not_run: boolean;
};

export interface CaseOutcome {
  test_case_number: string;
  test_page_area: string;
  test_scenario: string;
  confirmed: ConfirmedResult | null;
  /** No result rows in this run: the case was not part of the execution. */
  not_run: boolean;
  test_case_problem: boolean;
  bug_id: string | null;
  bug_severity: Severity | null;
  bug_status: string | null;
  qa_comments: string | null;
  screenshot: string | null;
  /** The failing step's actual output, or the reviewer's override reason. */
  actual_output: string | null;
  failing_step: {
    test_step_number: number;
    step_details: string;
    reason: string | null;
  } | null;
}

export interface ReportSummary {
  /** Cases in the sheet. */
  total: number;
  /** Confirmed pass or fail (the case ran and has a final verdict). */
  executed: number;
  passed: number;
  failed: number;
  failed_by_severity: Record<Severity, number>;
  /** Confirmed as not executed, plus cases not run in this execution. */
  not_executed: number;
  /** Cases added after the execution (no results; part of not_executed). */
  not_run: number;
  /** No confirmed result yet. */
  awaiting_confirmation: number;
  /** Cases Claude flagged as "Test case problem:" (any confirmation state). */
  test_case_problems: number;
  /** Every case has a confirmed result. */
  fully_reviewed: boolean;
}

/** Groups step rows into cases (rows must be sorted by case, then step). */
export function caseOutcomes(steps: ReportStepInput[]): CaseOutcome[] {
  const byCase = new Map<string, ReportStepInput[]>();
  for (const s of steps) {
    const list = byCase.get(s.test_case_number) ?? [];
    list.push(s);
    byCase.set(s.test_case_number, list);
  }
  return [...byCase.values()].map((rows) => {
    const first = rows[0];
    const failing = rows.find((r) => r.result === 'fail') ?? null;
    // Bug fields live on the first failing step row, else the first row.
    const bugRow = failing ?? first;
    const actual = caseActualOutputs(rows, {
      confirmed: first.user_confirmed_result,
      qa_comments: bugRow.qa_comments,
      ai_reason: first.ai_reason,
      ai_result: aiVerdict(first.ai_proposed_result),
    });
    return {
      test_case_number: first.test_case_number,
      test_page_area: first.test_page_area,
      test_scenario: first.test_scenario,
      confirmed: first.user_confirmed_result,
      not_run: rows.every((r) => r.result === null),
      test_case_problem: isTestCaseProblem(first.ai_reason),
      bug_id: bugRow.bug_id,
      bug_severity: bugRow.bug_severity,
      bug_status: bugRow.bug_status,
      qa_comments: bugRow.qa_comments,
      screenshot: rows.find((r) => r.screenshot)?.screenshot ?? null,
      actual_output: failing
        ? actual[rows.indexOf(failing)]
        : first.user_confirmed_result === 'fail'
          ? actual[0]
          : null,
      failing_step: failing
        ? {
            test_step_number: failing.test_step_number,
            step_details: failing.step_details,
            reason: failing.execution_error,
          }
        : null,
    };
  });
}

/** Summary in cases, from confirmed results only. */
export function summarize(cases: CaseOutcome[]): ReportSummary {
  const by = (r: ConfirmedResult) => cases.filter((c) => c.confirmed === r);
  const failed = by('fail');
  const failed_by_severity: Record<Severity, number> = {
    minor: 0,
    major: 0,
    critical: 0,
  };
  for (const c of failed) {
    if (c.bug_severity) failed_by_severity[c.bug_severity]++;
  }
  const passed = by('pass').length;
  const notRun = cases.filter((c) => c.not_run).length;
  const awaiting = cases.filter(
    (c) => c.confirmed === null && !c.not_run,
  ).length;
  return {
    total: cases.length,
    executed: passed + failed.length,
    passed,
    failed: failed.length,
    failed_by_severity,
    not_executed: by('not_executed').length + notRun,
    not_run: notRun,
    awaiting_confirmation: awaiting,
    test_case_problems: cases.filter((c) => c.test_case_problem).length,
    fully_reviewed: cases.length > 0 && awaiting === 0,
  };
}

/** The per-step sheet: the sheet columns as they stand for this run. */
export function sheetRows(steps: ReportStepInput[]): SheetRow[] {
  const actualByStep = new Map<ReportStepInput, string | null>();
  for (let i = 0; i < steps.length;) {
    let j = i;
    while (
      j < steps.length &&
      steps[j].test_case_number === steps[i].test_case_number
    )
      j++;
    const rows = steps.slice(i, j);
    const bugRow = rows.find((r) => r.result === 'fail') ?? rows[0];
    caseActualOutputs(rows, {
      confirmed: rows[0].user_confirmed_result,
      qa_comments: bugRow.qa_comments,
      ai_reason: rows[0].ai_reason,
      ai_result: aiVerdict(rows[0].ai_proposed_result),
    }).forEach((a, k) => actualByStep.set(rows[k], a));
    i = j;
  }
  return steps.map((s) => ({
    test_case_number: s.test_case_number,
    test_page_area: s.test_page_area,
    test_scenario: s.test_scenario,
    test_step_number: s.test_step_number,
    step_details: s.step_details,
    expected_output: s.expected_output,
    actual_output: actualByStep.get(s) ?? null,
    test_data: s.test_data,
    result: s.result ?? 'not_executed',
    bug_id: s.bug_id,
    screenshot: s.screenshot,
    qa_comments: s.qa_comments,
    bug_severity: s.bug_severity,
    confirmed_case_result: s.user_confirmed_result,
    not_run: s.result === null,
  }));
}
