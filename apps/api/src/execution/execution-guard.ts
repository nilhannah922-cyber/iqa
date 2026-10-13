import { ConflictException } from '@nestjs/common';

/** Execution states during which the test case sheet must not change. */
export const ACTIVE_EXECUTION_STATUSES = ['queued', 'running'] as const;

export function isExecutionActive(status: string | null | undefined): boolean {
  return (ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(
    status ?? '',
  );
}

/** Throws 409 while the run's test cases are queued for or being executed. */
export function assertSheetEditable(run: {
  execution_status: string | null;
}): void {
  if (isExecutionActive(run.execution_status)) {
    throw new ConflictException(
      "The test cases are being executed and can't be changed right now. Wait until the execution finishes.",
    );
  }
}
