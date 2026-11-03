/**
 * "Actual output" of a step (PROJECT_SPEC.md Section 5), derived from this
 * run's execution and review:
 *   pass          -> "As expected"
 *   fail          -> the executor's failure reason (actual observed value)
 *   not executed  -> "Not executed" plus the reason, if any
 * When a reviewer confirms a case as fail although every step passed, the
 * first step shows the reviewer's QA comment; without one, Claude's review
 * reason if Claude also proposed fail; otherwise a fixed note (Claude's
 * reason for a pass would contradict the reviewer).
 * Steps without a result in this run have no actual output (null).
 */
export interface StepOutcomeForOutput {
  result: 'pass' | 'fail' | 'not_executed' | null;
  execution_error: string | null;
}

export const AS_EXPECTED = 'As expected';

export function stepActualOutput(step: StepOutcomeForOutput): string | null {
  switch (step.result) {
    case null:
      return null;
    case 'pass':
      return AS_EXPECTED;
    case 'fail':
      return step.execution_error?.trim() || 'Failed (no reason recorded).';
    case 'not_executed': {
      const reason = step.execution_error?.replace(/^Not run:\s*/i, '').trim();
      return reason ? `Not executed: ${reason}` : 'Not executed';
    }
  }
}

/** Actual outputs of all steps of one case, in step order. */
export function caseActualOutputs(
  steps: StepOutcomeForOutput[],
  review: {
    confirmed: 'pass' | 'fail' | 'not_executed' | null;
    qa_comments: string | null;
    ai_reason: string | null;
    ai_result: 'pass' | 'fail' | null;
  },
): (string | null)[] {
  const outputs = steps.map(stepActualOutput);
  const anyFailed = steps.some((s) => s.result === 'fail');
  if (review.confirmed === 'fail' && !anyFailed && steps.length > 0) {
    outputs[0] =
      review.qa_comments?.trim() ||
      (review.ai_result === 'fail' ? review.ai_reason?.trim() : '') ||
      'Confirmed as fail by the reviewer (all steps passed).';
  }
  return outputs;
}
