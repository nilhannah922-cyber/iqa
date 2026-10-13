import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Editable fields of one test step row (PATCH .../steps/:stepNumber). */
export class UpdateTestStepDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  test_page_area?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  test_scenario?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  step_details?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  expected_output?: string;

  /** null or "" clears it. */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  test_data?: string | null;

  /** null or "" clears it. */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  qa_comments?: string | null;

  /** {action, selector?, value?}; checked against the run's page.json. */
  @IsOptional()
  @IsObject()
  step_action?: Record<string, unknown>;
}
