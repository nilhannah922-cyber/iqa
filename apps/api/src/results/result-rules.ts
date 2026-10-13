/**
 * Step 11 rules (pure, no database): deterministic outcome of a case, when a
 * case needs the reviewer's attention, and validation of Claude's verdicts
 * and of a reviewer's confirmation.
 */
export type Verdict = 'pass' | 'fail';
export type ConfirmedResult = 'pass' | 'fail' | 'not_executed';
export type Severity = 'minor' | 'major' | 'critical';
export type BugStatus = 'open' | 'fixed' | 'verified' | 'closed';

export const SEVERITIES: Severity[] = ['minor', 'major', 'critical'];
export const BUG_STATUSES: BugStatus[] = [
  'open',
  'fixed',
  'verified',
  'closed',
];
export const CONFIRMED_RESULTS: ConfirmedResult[] = [
  'pass',
  'fail',
  'not_executed',
];

/** Outcome of the deterministic execution for one case. */
export function deterministicOutcome(
  stepResults: string[],
): 'pass' | 'fail' | 'not_executed' {
  if (stepResults.includes('fail')) return 'fail';
  if (stepResults.length > 0 && stepResults.every((r) => r === 'pass')) {
    return 'pass';
  }
  return 'not_executed';
}

/**
 * A case needs attention when Claude disagrees with the execution, or when
 * it is (or may be) a fail that nobody has confirmed yet.
 */
export function needsAttention(c: {
  deterministic: 'pass' | 'fail' | 'not_executed';
  ai: Verdict | null;
  confirmed: ConfirmedResult | null;
}): boolean {
  const disagree =
    c.ai !== null &&
    c.deterministic !== 'not_executed' &&
    c.ai !== c.deterministic;
  const unconfirmedFail =
    c.confirmed === null && (c.deterministic === 'fail' || c.ai === 'fail');
  // A disagreement stays flagged until the reviewer decides.
  return (disagree && c.confirmed === null) || unconfirmedFail;
}

/** Cases "confirm all as proposed" may confirm: agreement and no decision yet. */
export function canAutoConfirm(c: {
  deterministic: 'pass' | 'fail' | 'not_executed';
  ai: Verdict | null;
  aiSeverity: Severity | null;
  confirmed: ConfirmedResult | null;
}): boolean {
  if (c.confirmed !== null || c.ai === null) return false;
  if (c.deterministic !== c.ai) return false;
  // A fail can only be confirmed with a severity.
  return c.ai === 'pass' || c.aiSeverity !== null;
}

export interface CaseVerdict {
  test_case_number: string;
  proposed_result: Verdict;
  reason: string;
  suggested_severity: Severity | null;
  bug_title: string | null;
}

/**
 * Validates Claude's verdicts for one batch. Every case of the batch must
 * appear exactly once; unknown or duplicate cases are dropped with a warning.
 */
export function validateVerdicts(
  raw: unknown,
  batchCases: string[],
): { verdicts: CaseVerdict[]; warnings: string[]; missing: string[] } {
  const warnings: string[] = [];
  const list =
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as { verdicts?: unknown }).verdicts)
      ? (raw as { verdicts: unknown[] }).verdicts
      : null;
  if (!list)
    throw new Error('Claude returned JSON without a "verdicts" array.');
  const expected = new Set(batchCases);
  const seen = new Set<string>();
  const verdicts: CaseVerdict[] = [];
  for (const item of list) {
    const v = (typeof item === 'object' && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    const number =
      typeof v.test_case_number === 'string' ? v.test_case_number : '';
    if (!expected.has(number)) {
      warnings.push(`Ignored a verdict for unknown case "${number}".`);
      continue;
    }
    if (seen.has(number)) {
      warnings.push(`Ignored a second verdict for ${number}.`);
      continue;
    }
    const result = v.proposed_result;
    if (result !== 'pass' && result !== 'fail') {
      warnings.push(`${number}: no valid proposed result.`);
      continue;
    }
    const reason =
      typeof v.reason === 'string' ? v.reason.trim().slice(0, 1000) : '';
    if (!reason) {
      warnings.push(`${number}: verdict has no reason and was ignored.`);
      continue;
    }
    let severity: Severity | null = SEVERITIES.includes(
      v.suggested_severity as Severity,
    )
      ? (v.suggested_severity as Severity)
      : null;
    let title =
      typeof v.bug_title === 'string'
        ? v.bug_title.trim().slice(0, 200) || null
        : null;
    if (result === 'pass') {
      severity = null;
      title = null;
    } else if (!severity) {
      warnings.push(
        `${number}: fail proposed without a severity; choose one when confirming.`,
      );
    }
    seen.add(number);
    verdicts.push({
      test_case_number: number,
      proposed_result: result,
      reason,
      suggested_severity: severity,
      bug_title: title,
    });
  }
  const missing = batchCases.filter((n) => !seen.has(n));
  for (const n of missing) warnings.push(`${n}: Claude returned no verdict.`);
  return { verdicts, warnings, missing };
}

export interface Confirmation {
  user_confirmed_result?: ConfirmedResult | null;
  bug_severity?: Severity | null;
  bug_id?: string | null;
  bug_status?: BugStatus | null;
  qa_comments?: string | null;
}

/**
 * Checks a reviewer's confirmation against the case's current state and
 * returns the values to store. Throws Error(message) for invalid input.
 */
export function resolveConfirmation(
  input: Confirmation,
  current: {
    confirmed: ConfirmedResult | null;
    bug_severity: Severity | null;
    bug_id: string | null;
    bug_status: BugStatus | null;
    qa_comments: string | null;
  },
): {
  confirmed: ConfirmedResult | null;
  bug_severity: Severity | null;
  bug_id: string | null;
  bug_status: BugStatus | null;
  qa_comments: string | null;
  needsBugId: boolean;
} {
  const confirmed =
    input.user_confirmed_result !== undefined
      ? input.user_confirmed_result
      : current.confirmed;
  const qa =
    input.qa_comments !== undefined
      ? input.qa_comments?.trim() || null
      : current.qa_comments;
  if (confirmed !== 'fail') {
    if (input.bug_severity || input.bug_id || input.bug_status) {
      throw new Error(
        'Bug severity, bug id and bug status only apply to a fail.',
      );
    }
    return {
      confirmed,
      bug_severity: null,
      bug_id: null,
      bug_status: null,
      qa_comments: qa,
      needsBugId: false,
    };
  }
  const severity =
    input.bug_severity !== undefined
      ? input.bug_severity
      : current.bug_severity;
  if (!severity) {
    throw new Error(
      'Choose a bug severity (minor, major or critical) for a fail.',
    );
  }
  const bugId =
    input.bug_id !== undefined ? input.bug_id?.trim() || null : current.bug_id;
  const status =
    input.bug_status !== undefined ? input.bug_status : current.bug_status;
  return {
    confirmed,
    bug_severity: severity,
    bug_id: bugId,
    bug_status: status ?? 'open',
    qa_comments: qa,
    needsBugId: !bugId,
  };
}
