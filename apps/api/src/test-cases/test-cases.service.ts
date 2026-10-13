import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, artifact_source as ArtifactSource } from '@prisma/client';
import type { PageAnalysis } from '../analysis/analyze-page';
import type { StorageProvider } from '../analysis/storage';
import { STORAGE } from '../analysis/storage.token';
import {
  ClaudeError,
  assertApiKeySet,
  pageSelectors,
} from '../claude/claude-json';
import { PrismaService } from '../prisma/prisma.service';
import {
  StepActionName,
  isExpectAction,
  validateStepAction,
} from './step-actions';

/** The action name stored in a step_action JSON value, if any. */
function stepActionName(value: Prisma.JsonValue): StepActionName {
  const action =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value.action
      : undefined;
  return (typeof action === 'string' ? action : '') as StepActionName;
}
import {
  ApprovedItem,
  GeneratedCase,
  TestCaseGenerator,
} from './test-case-generator';
import {
  lockNumbering,
  nextTestCaseNumbers,
  preserveRawReply,
} from './test-case-store';

export { formatTestCaseNumber } from './test-case-store';

const rowSelect = {
  test_case_number: true,
  test_page_area: true,
  test_scenario: true,
  test_step_number: true,
  step_details: true,
  expected_output: true,
  test_data: true,
  result: true,
  bug_id: true,
  screenshot: true,
  qa_comments: true,
  bug_severity: true,
  bug_status: true,
  checklist_item_id: true,
  source: true,
  step_action: true,
} satisfies Prisma.test_casesSelect;

export type TestCaseRow = Prisma.test_casesGetPayload<{
  select: typeof rowSelect;
}>;

/** The test case sheet of a run plus its approval state. */
export interface TestCaseSheet {
  run_id: string;
  /** When the user approved the sheet; null = not approved. */
  approved_at: Date | null;
  test_cases: TestCaseRow[];
}

/** Fields a reviewer may change on one step row (see UpdateTestStepDto). */
export interface TestStepEdit {
  test_page_area?: string;
  test_scenario?: string;
  step_details?: string;
  expected_output?: string;
  test_data?: string | null;
  qa_comments?: string | null;
  step_action?: Record<string, unknown>;
}

export interface GenerateTestCasesResult {
  run_id: string;
  approved_at: null;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Previously generated, never-executed cases deleted for this run. */
  replaced: number;
  /** Cases of this run kept because they already have execution results. */
  kept_executed: number;
  warnings: string[];
  test_cases: TestCaseRow[];
}

@Injectable()
export class TestCasesService {
  private readonly logger = new Logger(TestCasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  async generateForRun(runId: string): Promise<GenerateTestCasesResult> {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
      include: {
        checklist_items: { where: { approved: true }, orderBy: { id: 'asc' } },
      },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    if (!run.page_json_path || !run.screenshot_path) {
      throw new ConflictException(
        `Analysis run ${runId} has no page analysis (status: ${run.status}). Analyze the page again.`,
      );
    }
    if (run.checklist_items.length === 0) {
      throw new BadRequestException(
        'No checklist items are approved for this run. Approve at least one item before generating test cases.',
      );
    }
    try {
      assertApiKeySet();
    } catch (err) {
      throw new ServiceUnavailableException((err as Error).message);
    }

    let analysis: PageAnalysis;
    let screenshot: Buffer;
    try {
      analysis = JSON.parse(
        (await this.storage.read(run.page_json_path)).toString('utf8'),
      ) as PageAnalysis;
      screenshot = await this.storage.read(run.screenshot_path);
    } catch {
      throw new ConflictException(
        `The stored page analysis for run ${runId} could not be read. Analyze the page again.`,
      );
    }

    const items: ApprovedItem[] = run.checklist_items.map((it) => ({
      id: it.id,
      title: it.title,
      description: it.description,
      related_selectors: Array.isArray(it.related_selectors)
        ? (it.related_selectors as string[])
        : [],
    }));

    let generated;
    try {
      generated = await new TestCaseGenerator().generate(
        analysis,
        screenshot,
        items,
      );
    } catch (err) {
      if (err instanceof ClaudeError) {
        const rawKey =
          err.rawReply !== undefined
            ? await preserveRawReply(
                this.storage,
                this.logger,
                runId,
                'testcases',
                err.message,
                {
                  rawReply: err.rawReply,
                  model: err.model,
                  usage: err.usage,
                },
              )
            : undefined;
        throw new BadGatewayException({
          message: err.message,
          error: 'Bad Gateway',
          statusCode: 502,
          run_id: runId,
          ...(rawKey && { raw_reply_key: rawKey }),
        });
      }
      throw err;
    }
    for (const w of generated.warnings) {
      this.logger.warn(`Run ${runId}: ${w}`);
    }

    // A case inherits its checklist item's source (scan / user_note / cross_check).
    const itemSource = new Map(
      run.checklist_items.map((it) => [it.id, it.source]),
    );
    let replaced: number;
    let kept: number;
    try {
      ({ replaced, kept } = await this.replaceCases(
        runId,
        generated.cases,
        itemSource,
      ));
    } catch (err) {
      await preserveRawReply(
        this.storage,
        this.logger,
        runId,
        'testcases',
        `Saving test cases failed: ${err instanceof Error ? err.message : String(err)}`,
        generated,
      );
      throw err;
    }
    this.logger.log(
      `Run ${runId}: stored ${generated.cases.length} test cases from ${generated.model} ` +
        `(input=${generated.usage.input_tokens}, output=${generated.usage.output_tokens} tokens; ` +
        `replaced ${replaced}, kept ${kept} executed)`,
    );

    return {
      run_id: runId,
      approved_at: null,
      model: generated.model,
      usage: {
        input_tokens: generated.usage.input_tokens,
        output_tokens: generated.usage.output_tokens,
      },
      replaced,
      kept_executed: kept,
      warnings: generated.warnings,
      test_cases: await this.rowsForRun(runId),
    };
  }

  async listForRun(runId: string): Promise<TestCaseSheet> {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
      select: { test_cases_approved_at: true },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    return {
      run_id: runId,
      approved_at: run.test_cases_approved_at,
      test_cases: await this.rowsForRun(runId),
    };
  }

  /**
   * Edits one step row. Page area and scenario belong to the whole case and
   * are written to every row of it. Clears the sheet's approval.
   */
  async updateStep(
    runId: string,
    caseNumber: string,
    stepNumber: number,
    edit: TestStepEdit,
  ): Promise<TestCaseSheet> {
    const required = [
      'test_page_area',
      'test_scenario',
      'step_details',
      'expected_output',
    ] as const;
    const caseData: Prisma.test_casesUpdateManyMutationInput = {};
    const stepData: Prisma.test_casesUpdateInput = {};
    for (const field of required) {
      const value = edit[field];
      if (value === undefined) continue;
      if (!value.trim()) {
        throw new BadRequestException(`${field} cannot be empty.`);
      }
      if (field === 'test_page_area' || field === 'test_scenario') {
        caseData[field] = value.trim();
      } else {
        stepData[field] = value.trim();
      }
    }
    for (const field of ['test_data', 'qa_comments'] as const) {
      const value = edit[field];
      if (value !== undefined) stepData[field] = value?.trim() || null;
    }
    if (
      Object.keys(caseData).length === 0 &&
      Object.keys(stepData).length === 0 &&
      edit.step_action === undefined
    ) {
      throw new BadRequestException('Nothing to update.');
    }

    const { run, steps } = await this.editableCase(runId, caseNumber);
    const target = steps.find((s) => s.test_step_number === stepNumber);
    if (!target) {
      throw new NotFoundException(
        `Step ${stepNumber} not found in test case ${caseNumber}.`,
      );
    }

    if (edit.step_action !== undefined) {
      const selectors = await this.selectorsForRun(run);
      const check = validateStepAction(edit.step_action, selectors);
      if (!check.ok) {
        throw new BadRequestException(`Invalid step action: ${check.reason}.`);
      }
      const hasExpectLeft =
        isExpectAction(check.step.action) ||
        steps.some(
          (s) =>
            s.test_step_number !== stepNumber &&
            isExpectAction(stepActionName(s.step_action)),
        );
      if (!hasExpectLeft) {
        throw new BadRequestException(
          `Test case ${caseNumber} must keep at least one expect_* step; this change would remove its last one.`,
        );
      }
      stepData.step_action = { ...check.step };
    }

    await this.prisma.$transaction([
      ...(Object.keys(caseData).length
        ? [
            this.prisma.test_cases.updateMany({
              where: { test_case_number: caseNumber, test_run_id: runId },
              data: caseData,
            }),
          ]
        : []),
      ...(Object.keys(stepData).length
        ? [
            this.prisma.test_cases.update({
              where: {
                test_case_number_test_step_number: {
                  test_case_number: caseNumber,
                  test_step_number: stepNumber,
                },
              },
              data: stepData,
            }),
          ]
        : []),
      this.clearApproval(runId),
    ]);
    return this.listForRun(runId);
  }

  /** Deletes one step and renumbers the rest. Clears the sheet's approval. */
  async deleteStep(
    runId: string,
    caseNumber: string,
    stepNumber: number,
  ): Promise<TestCaseSheet> {
    const { steps } = await this.editableCase(runId, caseNumber);
    if (!steps.some((s) => s.test_step_number === stepNumber)) {
      throw new NotFoundException(
        `Step ${stepNumber} not found in test case ${caseNumber}.`,
      );
    }
    const rest = steps.filter((s) => s.test_step_number !== stepNumber);
    if (rest.length === 0) {
      throw new BadRequestException(
        `Step ${stepNumber} is the only step of ${caseNumber}. Delete the whole test case instead.`,
      );
    }
    if (!rest.some((s) => isExpectAction(stepActionName(s.step_action)))) {
      throw new BadRequestException(
        `Deleting step ${stepNumber} would leave ${caseNumber} with no expect_* step. Delete the whole test case, or add another check first.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.test_cases.delete({
        where: {
          test_case_number_test_step_number: {
            test_case_number: caseNumber,
            test_step_number: stepNumber,
          },
        },
      }),
      // Ascending order keeps every target number free when it is written.
      ...rest
        .filter((s) => s.test_step_number > stepNumber)
        .map((s) =>
          this.prisma.test_cases.update({
            where: {
              test_case_number_test_step_number: {
                test_case_number: caseNumber,
                test_step_number: s.test_step_number,
              },
            },
            data: { test_step_number: s.test_step_number - 1 },
          }),
        ),
      this.clearApproval(runId),
    ]);
    return this.listForRun(runId);
  }

  /** Deletes a whole test case. Clears the sheet's approval. */
  async deleteCase(runId: string, caseNumber: string): Promise<TestCaseSheet> {
    await this.editableCase(runId, caseNumber);
    await this.prisma.$transaction([
      this.prisma.test_cases.deleteMany({
        where: { test_case_number: caseNumber, test_run_id: runId },
      }),
      this.clearApproval(runId),
    ]);
    return this.listForRun(runId);
  }

  /** Records that the user approved the run's test case sheet. */
  async approve(runId: string): Promise<TestCaseSheet> {
    const sheet = await this.listForRun(runId);
    if (sheet.test_cases.length === 0) {
      throw new BadRequestException(
        'There are no test cases to approve. Generate test cases first.',
      );
    }
    await this.prisma.test_runs.update({
      where: { id: runId },
      data: { test_cases_approved_at: new Date() },
    });
    return this.listForRun(runId);
  }

  private clearApproval(runId: string) {
    return this.prisma.test_runs.update({
      where: { id: runId },
      data: { test_cases_approved_at: null },
    });
  }

  /**
   * Loads a case of the run for editing: 404 if the run or case is unknown,
   * 409 if any of its steps already has execution results.
   */
  private async editableCase(runId: string, caseNumber: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    const steps = await this.prisma.test_cases.findMany({
      where: { test_case_number: caseNumber, test_run_id: runId },
      select: {
        test_step_number: true,
        step_action: true,
        _count: { select: { run_results: true } },
      },
      orderBy: { test_step_number: 'asc' },
    });
    if (steps.length === 0) {
      throw new NotFoundException(
        `Test case ${caseNumber} not found in run ${runId}.`,
      );
    }
    if (steps.some((s) => s._count.run_results > 0)) {
      throw new ConflictException(
        `Test case ${caseNumber} has already been executed and can no longer be edited.`,
      );
    }
    return { run, steps };
  }

  private async selectorsForRun(run: {
    id: string;
    page_json_path: string | null;
  }) {
    if (!run.page_json_path) {
      throw new ConflictException(
        `Analysis run ${run.id} has no page analysis, so step actions cannot be checked.`,
      );
    }
    try {
      const analysis = JSON.parse(
        (await this.storage.read(run.page_json_path)).toString('utf8'),
      ) as PageAnalysis;
      return pageSelectors(analysis);
    } catch {
      throw new ConflictException(
        `The stored page analysis for run ${run.id} could not be read.`,
      );
    }
  }

  private rowsForRun(runId: string): Promise<TestCaseRow[]> {
    return this.prisma.test_cases.findMany({
      where: { test_run_id: runId },
      select: rowSelect,
      orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
    });
  }

  /**
   * Deletes this run's generated cases that were never executed, then inserts
   * the new cases with the next global numbers, in one transaction.
   */
  private replaceCases(
    runId: string,
    cases: GeneratedCase[],
    itemSource: Map<string, ArtifactSource>,
  ): Promise<{ replaced: number; kept: number }> {
    return this.prisma.$transaction(async (tx) => {
      await lockNumbering(tx);

      const old = await tx.test_cases.findMany({
        where: { test_run_id: runId },
        select: {
          test_case_number: true,
          _count: { select: { run_results: true } },
        },
      });
      const executed = new Set(
        old
          .filter((r) => r._count.run_results > 0)
          .map((r) => r.test_case_number),
      );
      const removable = [
        ...new Set(
          old.map((r) => r.test_case_number).filter((n) => !executed.has(n)),
        ),
      ];
      if (removable.length) {
        await tx.test_cases.deleteMany({
          where: { test_case_number: { in: removable } },
        });
      }

      const numbers = await nextTestCaseNumbers(tx, cases.length);

      const rows: Prisma.test_casesCreateManyInput[] = cases.flatMap((c, i) => {
        const number = numbers[i];
        return c.steps.map((s, si) => ({
          test_case_number: number,
          test_page_area: c.test_page_area,
          test_scenario: c.test_scenario,
          test_step_number: si + 1,
          step_details: s.step_details,
          expected_output: s.expected_output,
          test_data: s.test_data,
          result: 'not_executed' as const,
          test_run_id: runId,
          checklist_item_id: c.checklist_item_id,
          source: itemSource.get(c.checklist_item_id) ?? null,
          step_action: { ...s.step_action },
        }));
      });
      await tx.test_cases.createMany({ data: rows });
      // A regenerated sheet must be reviewed and approved again.
      await tx.test_runs.update({
        where: { id: runId },
        data: { test_cases_approved_at: null },
      });
      return { replaced: removable.length, kept: executed.size };
    });
  }
}
