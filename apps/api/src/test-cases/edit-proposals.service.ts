/**
 * Step 9b: instruction-based edits with diff + confirm.
 *
 * propose():  instruction -> Claude -> validated operations + diff, stored as an
 *             edit_requests row (status "proposed"); test_cases is untouched.
 * apply():    re-checks the sheet version, applies the stored operations in one
 *             transaction, clears the approval, marks the proposal "applied".
 * discard():  marks it "discarded". list(): the audit trail for a run.
 * addStep() / addCase(): the same write path for direct, non-AI additions.
 */
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
import type Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import type { PageAnalysis } from '../analysis/analyze-page';
import type { StorageProvider } from '../analysis/storage';
import { STORAGE } from '../analysis/storage.token';
import {
  ClaudeError,
  ClaudeJsonClient,
  assertApiKeySet,
  pageSelectors,
} from '../claude/claude-json';
import { assertSheetEditable } from '../execution/execution-guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  ArtifactSource,
  EDIT_OPS,
  EditContext,
  EditOperation,
  SheetCase,
  SheetDiff,
  SheetStep,
  buildDiff,
  sheetVersion,
  simulate,
  validateOperations,
} from './sheet-edits';
import { STEP_ACTION_NAMES, StepAction } from './step-actions';
import { ACTION_REFERENCE } from './test-case-generator';
import {
  lockNumbering,
  nextTestCaseNumbers,
  preserveRawReply,
} from './test-case-store';
import { TestCaseSheet, TestCasesService } from './test-cases.service';

const MAX_TOKENS = 32_000;
export const MAX_INSTRUCTION_LENGTH = 2000;

export type ProposalStatus = 'proposed' | 'applied' | 'discarded' | 'empty';

export interface EditProposalView {
  id: string;
  run_id: string;
  instruction: string;
  status: ProposalStatus;
  created_at: Date;
  decided_at: Date | null;
  diff: SheetDiff;
  warnings: string[];
  operation_count: number;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

const stepSchema = {
  type: 'object',
  properties: {
    step_details: { type: 'string' },
    expected_output: { type: 'string' },
    test_data: { type: 'string' },
    qa_comments: { type: 'string' },
    action: { type: 'string', enum: [...STEP_ACTION_NAMES, ''] },
    selector: { type: 'string' },
    value: { type: 'string' },
  },
  required: [
    'step_details',
    'expected_output',
    'test_data',
    'qa_comments',
    'action',
    'selector',
    'value',
  ],
  additionalProperties: false,
};

function proposalSchema(approvedItemIds: string[]) {
  return {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: [...EDIT_OPS] },
            test_case_number: { type: 'string' },
            step_number: { type: 'integer' },
            after_step: { type: 'integer' },
            test_page_area: { type: 'string' },
            test_scenario: { type: 'string' },
            checklist_item_id: {
              type: 'string',
              enum: [...approvedItemIds, ''],
            },
            step: stepSchema,
            steps: { type: 'array', items: stepSchema },
            reason: { type: 'string' },
          },
          required: [
            'op',
            'test_case_number',
            'step_number',
            'after_step',
            'test_page_area',
            'test_scenario',
            'checklist_item_id',
            'step',
            'steps',
            'reason',
          ],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
    },
    required: ['operations', 'notes'],
    additionalProperties: false,
  };
}

const SYSTEM_PROMPT = `You edit an existing functional test case sheet for one web page, following a single instruction from a QA reviewer. You receive page.json (the page's interactive elements under "elements" and visible text blocks under "content", each with a CSS selector), the approved checklist items, the editable test cases and the instruction.

Return only the operations needed to carry out the instruction, nothing more. Leave everything the instruction does not ask about unchanged.

Operations (fill every field; use "" , 0 or [] for fields an operation does not use):
- update_fields: change test_page_area and/or test_scenario of case test_case_number ("" = keep).
- update_step: replace step step_number of case test_case_number with "step" (give the full new step; copy unchanged fields exactly).
- add_step: insert "step" into case test_case_number after its step after_step (0 = before the first step).
- delete_step: delete step step_number of case test_case_number.
- add_case: add a new case with test_page_area, test_scenario, checklist_item_id (one of the approved items, or "") and "steps". Leave test_case_number "" (numbers are assigned later). Start with a "goto" step.
- delete_case: delete case test_case_number.
- reason: one short sentence explaining the operation for the reviewer.

Rules:
- step_number and after_step always refer to the step numbers shown in the sheet you were given, even after other operations; do not renumber.
- Every case must keep at least one expect_* step, and every new case needs one that verifies its purpose.
- Steps are executed by an automated Playwright runner exactly as written. action, selector and value are the machine-readable step:
${ACTION_REFERENCE}
- Use only selectors that appear in page.json, copied exactly. Content selectors are only for expect_visible, expect_text and wait; click also accepts a content selector whose tag is "label".
- test_data holds only data typed or selected in that step ("" for checks, clicks and navigation). Keep qa_comments as they are unless the instruction is about them.
- For expect_value, an empty value "" checks that the field is empty.
- Use expect_focused for focus checks; do not add fixed pauses.
- Never set results, bug ids, severities or screenshots.
- If the instruction is unclear, impossible on this page, or already satisfied, return no operations and explain why in notes. Otherwise notes may be "".`;

function stepActionOf(value: Prisma.JsonValue): StepAction {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return {
      action: (typeof v.action === 'string'
        ? v.action
        : '') as StepAction['action'],
      ...(typeof v.selector === 'string' && { selector: v.selector }),
      ...(typeof v.value === 'string' && { value: v.value }),
    };
  }
  return { action: '' as StepAction['action'] };
}

@Injectable()
export class EditProposalsService {
  private readonly logger = new Logger(EditProposalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
    private readonly testCases: TestCasesService,
  ) {}

  // ------------------------------------------------------------ proposals

  async propose(runId: string, instruction: string): Promise<EditProposalView> {
    const text = instruction.trim();
    if (!text) throw new BadRequestException('Write an instruction first.');
    if (text.length > MAX_INSTRUCTION_LENGTH) {
      throw new BadRequestException(
        `The instruction is too long (max ${MAX_INSTRUCTION_LENGTH} characters).`,
      );
    }
    const { ctx, analysis, approvedItems } = await this.loadContext(runId);
    const editable = ctx.sheet.filter((c) => !c.executed);
    if (editable.length === 0) {
      throw new BadRequestException(
        'There are no editable test cases for this run. Generate test cases first.',
      );
    }
    try {
      assertApiKeySet();
    } catch (err) {
      throw new ServiceUnavailableException((err as Error).message);
    }

    const version = sheetVersion(ctx.sheet);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: 'text', text: `page.json:\n${JSON.stringify(analysis)}` },
      {
        type: 'text',
        text: `Approved checklist items:\n${JSON.stringify(approvedItems)}`,
      },
      {
        type: 'text',
        text: `Editable test cases:\n${JSON.stringify(
          editable.map((c) => ({
            test_case_number: c.test_case_number,
            test_page_area: c.test_page_area,
            test_scenario: c.test_scenario,
            checklist_item_id: c.checklist_item_id,
            steps: c.steps.map((s) => ({
              step_number: s.test_step_number,
              step_details: s.step_details,
              expected_output: s.expected_output,
              test_data: s.test_data ?? '',
              qa_comments: s.qa_comments ?? '',
              ...s.step_action,
            })),
          })),
        )}`,
      },
      { type: 'text', text: `Instruction:\n${text}` },
    ];

    let reply;
    try {
      reply = await new ClaudeJsonClient().requestJson({
        system: SYSTEM_PROMPT,
        content,
        schema: proposalSchema(approvedItems.map((i) => i.id)),
        maxTokens: MAX_TOKENS,
      });
    } catch (err) {
      if (err instanceof ClaudeError) {
        this.logger.warn(`Run ${runId}: edit proposal failed: ${err.message}`);
        const rawKey =
          err.rawReply !== undefined
            ? await preserveRawReply(
                this.storage,
                this.logger,
                runId,
                'editproposal',
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

    const usage = {
      input_tokens: reply.usage.input_tokens,
      output_tokens: reply.usage.output_tokens,
    };
    try {
      const parsed = reply.parsed as { operations?: unknown; notes?: unknown };
      if (!Array.isArray(parsed?.operations)) {
        throw new Error('Claude returned JSON without an "operations" array.');
      }
      const { operations, warnings } = validateOperations(
        parsed.operations,
        ctx,
      );
      const notes = typeof parsed.notes === 'string' ? parsed.notes.trim() : '';
      if (notes) warnings.unshift(`Claude's note: ${notes}`);
      const diff = buildDiff(ctx.sheet, operations);

      const row = await this.prisma.edit_requests.create({
        data: {
          test_run_id: runId,
          instruction: text,
          source: 'user_note',
          status: operations.length ? 'proposed' : 'empty',
          operations: operations as unknown as Prisma.InputJsonValue,
          proposed_diff: diff as unknown as Prisma.InputJsonValue,
          warnings,
          sheet_version: version,
          model: reply.model,
          usage,
        },
      });
      this.logger.log(
        `Run ${runId}: edit proposal ${row.id} with ${operations.length} operations ` +
          `(${warnings.length} warnings; input=${usage.input_tokens}, output=${usage.output_tokens} tokens)`,
      );
      return this.toView(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const rawKey = await preserveRawReply(
        this.storage,
        this.logger,
        runId,
        'editproposal',
        `Processing the edit proposal failed: ${message}`,
        { rawReply: reply.rawReply, model: reply.model, usage },
      );
      throw new BadGatewayException({
        message: `Claude replied, but the proposal could not be processed: ${message}`,
        error: 'Bad Gateway',
        statusCode: 502,
        run_id: runId,
        ...(rawKey && { raw_reply_key: rawKey }),
      });
    }
  }

  async apply(
    runId: string,
    proposalId: string,
  ): Promise<{ proposal: EditProposalView; sheet: TestCaseSheet }> {
    const proposal = await this.findProposal(runId, proposalId);
    this.assertOpen(proposal);
    const operations = (proposal.operations ??
      []) as unknown as EditOperation[];

    await this.prisma.$transaction(
      async (tx) => {
        await lockNumbering(tx);
        await this.assertEditable(tx, runId);
        const sheet = await this.loadSheet(tx, runId);
        if (sheetVersion(sheet) !== proposal.sheet_version) {
          throw new ConflictException(
            'The test cases changed after this proposal was made, so it was not applied. Ask for the change again.',
          );
        }
        await this.writeOperations(tx, runId, sheet, operations);
        const marked = await tx.edit_requests.updateMany({
          where: { id: proposalId, status: 'proposed' },
          data: { status: 'applied', decided_at: new Date() },
        });
        if (marked.count !== 1) {
          throw new ConflictException('This proposal was already decided.');
        }
      },
      { timeout: 20_000 },
    );
    const updated = await this.findProposal(runId, proposalId);
    return {
      proposal: this.toView(updated),
      sheet: await this.testCases.listForRun(runId),
    };
  }

  async discard(runId: string, proposalId: string): Promise<EditProposalView> {
    const proposal = await this.findProposal(runId, proposalId);
    this.assertOpen(proposal);
    const marked = await this.prisma.edit_requests.updateMany({
      where: { id: proposalId, status: 'proposed' },
      data: { status: 'discarded', decided_at: new Date() },
    });
    if (marked.count !== 1) {
      throw new ConflictException('This proposal was already decided.');
    }
    return this.toView(await this.findProposal(runId, proposalId));
  }

  async list(runId: string): Promise<EditProposalView[]> {
    await this.findRun(runId);
    const rows = await this.prisma.edit_requests.findMany({
      where: { test_run_id: runId },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  // ----------------------------------------------- direct (non-AI) additions

  /** Inserts one step after `afterStep` (0 = first) of an existing case. */
  async addStep(
    runId: string,
    caseNumber: string,
    afterStep: number,
    step: unknown,
  ): Promise<TestCaseSheet> {
    return this.applyDirect(runId, [
      {
        op: 'add_step',
        test_case_number: caseNumber,
        after_step: afterStep,
        step,
      },
    ]);
  }

  /** Adds a new case (numbered with the global sequence), source user_note. */
  async addCase(
    runId: string,
    newCase: {
      test_page_area: string;
      test_scenario: string;
      checklist_item_id?: string | null;
      steps: unknown[];
    },
  ): Promise<TestCaseSheet> {
    return this.applyDirect(runId, [{ op: 'add_case', ...newCase }]);
  }

  /** Validates raw operations against the current sheet and writes them now. */
  private async applyDirect(
    runId: string,
    rawOps: unknown[],
  ): Promise<TestCaseSheet> {
    const { ctx } = await this.loadContext(runId);
    const { operations, warnings } = validateOperations(rawOps, ctx);
    if (operations.length !== rawOps.length) {
      throw new BadRequestException(warnings.join(' ') || 'Invalid change.');
    }
    await this.prisma.$transaction(async (tx) => {
      await lockNumbering(tx);
      await this.assertEditable(tx, runId);
      const sheet = await this.loadSheet(tx, runId);
      if (sheetVersion(sheet) !== sheetVersion(ctx.sheet)) {
        throw new ConflictException(
          'The test cases changed while saving. Try again.',
        );
      }
      await this.writeOperations(tx, runId, sheet, operations);
    });
    return this.testCases.listForRun(runId);
  }

  // -------------------------------------------------------------- writing

  /**
   * Writes the simulated result: changed cases are rewritten (steps
   * renumbered), removed cases deleted, added cases get new global numbers.
   * Clears the sheet approval. Must run inside a transaction holding the
   * numbering lock.
   */
  private async writeOperations(
    tx: Prisma.TransactionClient,
    runId: string,
    sheet: SheetCase[],
    operations: EditOperation[],
  ): Promise<void> {
    const { cases } = simulate(sheet, operations);
    const touched = cases.filter(
      (c) => c.status === 'changed' || c.status === 'removed',
    );
    if (touched.some((c) => c.before?.executed)) {
      throw new ConflictException(
        'One of the affected test cases has been executed and can no longer be changed.',
      );
    }
    const touchedNumbers = touched.map((c) => c.key);
    if (touchedNumbers.length) {
      await tx.test_cases.deleteMany({
        where: { test_run_id: runId, test_case_number: { in: touchedNumbers } },
      });
    }

    const added = cases.filter((c) => c.status === 'added');
    const numbers = await nextTestCaseNumbers(tx, added.length);
    const rows: Prisma.test_casesCreateManyInput[] = [];
    const rowsFor = (
      number: string,
      c: (typeof cases)[number],
      source: ArtifactSource | null,
    ) =>
      c.steps.map((s, i): Prisma.test_casesCreateManyInput => ({
        test_case_number: number,
        test_page_area: c.test_page_area,
        test_scenario: c.test_scenario,
        test_step_number: i + 1,
        step_details: s.step.step_details,
        expected_output: s.step.expected_output,
        test_data: s.step.test_data,
        qa_comments: s.step.qa_comments,
        result: 'not_executed',
        test_run_id: runId,
        checklist_item_id: c.checklist_item_id,
        source,
        step_action: { ...s.step.step_action },
      }));
    for (const c of cases) {
      if (c.status === 'changed') rows.push(...rowsFor(c.key, c, c.source));
    }
    added.forEach((c, i) => rows.push(...rowsFor(numbers[i], c, 'user_note')));
    if (rows.length) await tx.test_cases.createMany({ data: rows });

    await tx.test_runs.update({
      where: { id: runId },
      data: { test_cases_approved_at: null },
    });
  }

  // -------------------------------------------------------------- loading

  /** 409 while the run's test cases are being executed. */
  private async assertEditable(tx: Prisma.TransactionClient, runId: string) {
    const run = await tx.test_runs.findUnique({
      where: { id: runId },
      select: { execution_status: true },
    });
    if (run) assertSheetEditable(run);
  }

  private async findRun(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    return run;
  }

  private async findProposal(runId: string, proposalId: string) {
    const row = await this.prisma.edit_requests.findFirst({
      where: { id: proposalId, test_run_id: runId },
    });
    if (!row) {
      throw new NotFoundException(
        `Edit proposal ${proposalId} not found for run ${runId}.`,
      );
    }
    return row;
  }

  private assertOpen(proposal: { status: string }) {
    if (proposal.status === 'proposed') return;
    throw new ConflictException(
      proposal.status === 'empty'
        ? 'This proposal has no changes to apply.'
        : `This proposal was already ${proposal.status}.`,
    );
  }

  /** The run's whole sheet as SheetCase[], with executed flags. */
  async loadSheet(
    db: Prisma.TransactionClient | PrismaService,
    runId: string,
  ): Promise<SheetCase[]> {
    const rows = await db.test_cases.findMany({
      where: { test_run_id: runId },
      orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
      include: { _count: { select: { run_results: true } } },
    });
    const cases = new Map<string, SheetCase>();
    for (const r of rows) {
      let c = cases.get(r.test_case_number);
      if (!c) {
        c = {
          test_case_number: r.test_case_number,
          test_page_area: r.test_page_area,
          test_scenario: r.test_scenario,
          checklist_item_id: r.checklist_item_id,
          source: r.source,
          executed: false,
          steps: [],
        };
        cases.set(r.test_case_number, c);
      }
      if (r._count.run_results > 0) c.executed = true;
      const step: SheetStep & { test_step_number: number } = {
        test_step_number: r.test_step_number,
        step_details: r.step_details,
        expected_output: r.expected_output,
        test_data: r.test_data,
        qa_comments: r.qa_comments,
        step_action: stepActionOf(r.step_action),
      };
      c.steps.push(step);
    }
    return [...cases.values()];
  }

  private async loadContext(runId: string): Promise<{
    ctx: EditContext;
    analysis: PageAnalysis;
    approvedItems: { id: string; title: string; description: string }[];
  }> {
    const run = await this.findRun(runId);
    if (!run.page_json_path) {
      throw new ConflictException(
        `Analysis run ${runId} has no page analysis. Analyze the page again.`,
      );
    }
    let analysis: PageAnalysis;
    try {
      analysis = JSON.parse(
        (await this.storage.read(run.page_json_path)).toString('utf8'),
      ) as PageAnalysis;
    } catch {
      throw new ConflictException(
        `The stored page analysis for run ${runId} could not be read.`,
      );
    }
    const items = await this.prisma.checklist_items.findMany({
      where: { test_run_id: runId, approved: true },
      select: { id: true, title: true, description: true },
      orderBy: { id: 'asc' },
    });
    return {
      ctx: {
        sheet: await this.loadSheet(this.prisma, runId),
        selectors: pageSelectors(analysis),
        approvedItemIds: new Set(items.map((i) => i.id)),
      },
      analysis,
      approvedItems: items,
    };
  }

  private toView(row: {
    id: string;
    test_run_id: string;
    instruction: string;
    status: string;
    created_at: Date;
    decided_at: Date | null;
    proposed_diff: Prisma.JsonValue;
    warnings: Prisma.JsonValue;
    operations: Prisma.JsonValue;
    model: string | null;
    usage: Prisma.JsonValue;
  }): EditProposalView {
    return {
      id: row.id,
      run_id: row.test_run_id,
      instruction: row.instruction,
      status: row.status as ProposalStatus,
      created_at: row.created_at,
      decided_at: row.decided_at,
      diff: row.proposed_diff as unknown as SheetDiff,
      warnings: (row.warnings ?? []) as string[],
      operation_count: Array.isArray(row.operations)
        ? row.operations.length
        : 0,
      model: row.model,
      usage: (row.usage ?? null) as EditProposalView['usage'],
    };
  }
}
