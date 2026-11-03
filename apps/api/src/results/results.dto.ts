import { IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';
import { BUG_STATUSES, CONFIRMED_RESULTS, SEVERITIES } from './result-rules';

const given = (_o: object, v: unknown) => v !== undefined && v !== null;

/** PATCH /analysis/:id/results/:caseNumber. null clears a value. */
export class ConfirmResultDto {
  /** pass | fail | not_executed, or null to unconfirm. */
  @ValidateIf(given)
  @IsIn(CONFIRMED_RESULTS)
  user_confirmed_result?: 'pass' | 'fail' | 'not_executed' | null;

  @ValidateIf(given)
  @IsIn(SEVERITIES)
  bug_severity?: 'minor' | 'major' | 'critical' | null;

  /** Free text (e.g. BUG-0003 or a tracker key); empty = auto-number on fail. */
  @ValidateIf(given)
  @IsString()
  @MaxLength(50)
  bug_id?: string | null;

  @ValidateIf(given)
  @IsIn(BUG_STATUSES)
  bug_status?: 'open' | 'fixed' | 'verified' | 'closed' | null;

  @ValidateIf(given)
  @IsString()
  @MaxLength(2000)
  qa_comments?: string | null;
}
