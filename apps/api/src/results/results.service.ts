/**
 * Step 11: Claude proposes pass/fail per executed test case from the step
 * outcomes and the case screenshot; the reviewer confirms or overrides.
 * The deterministic results in test_run_results.result are never changed.
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
import type { StorageProvider } from '../analysis/storage';
import { STORAGE } from '../analysis/storage.token';
import {
  ClaudeError,
  ClaudeJsonClient,
  assertApiKeySet,
  screenshotBlock,
} from '../claude/claude-json';
import { isExecutionActive } from '../execution/execution-guard';
import { PrismaService } from '../prisma/prisma.service';
import { preserveRawReply } from '../test-cases/test-case-store';
import {
  CaseVerdict,
  Confirmation,
  SEVERITIES,
  canAutoConfirm,
  deterministicOutcome,
  needsAttention,
  resolveConfirmation,
  validateVerdicts,
} from './result-rules';

export const REVIEW_BATCH_SIZE = 5;
const MAX_TOKENS = 8_000;
// Serializes bug id numbering (transaction-scoped advisory lock).
const BUG_NUMBER_LOCK_KEY = 4_203_772;

const SYSTEM_PROMPT = `You review the results of automated functional tests of one web page. A Playwright runner executed each test case deterministically. For each case you get its scenario, every step with the expected output, the step's deterministic result (pass, fail or not_executed) and failure reason, and one screenshot taken at the first failure or at the end of the case.

Propose a verdict per case: "pass" or "fail".
Rules:
- A deterministic failure is a fail. Only when the evidence shows the test itself is wrong (for example a wrong selector, a wrong or impossible expectation, a step that cannot work on this page) keep "fail" and start the reason with "Test case problem:" so the reviewer fixes the test rather than filing a page bug.
- A case where every step passed is a pass, unless the screenshot clearly contradicts an expected output. Only then propose fail and say exactly what the screenshot shows.
- Be conservative. Base the reason only on the step outcomes and what is visible in the screenshot; never invent evidence. If the screenshot is missing or unclear, say so and rely on the step outcomes.
- reason: one or two short sentences.
- For a fail: suggested_severity (critical = the page's main purpose is broken, major = an important function is broken, minor = cosmetic or edge case) and bug_title (one line, describes the defect, or the test problem). For a pass use "" for both.
- Return exactly one verdict per case you were given.`;

function verdictSchema(caseNumbers: string[]) {
  return {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            test_case_number: { type: 'string', enum: caseNumbers },
            proposed_result: { type: 'string', enum: ['pass', 'fail'] },
            reason: { type: 'string' },
            suggested_severity: { type: 'string', enum: [...SEVERITIES, ''] },
            bug_title: { type: 'string' },
          },
          required: [
            'test_case_number',
            'proposed_result',
            'reason',
            'suggested_severity',
            'bug_title',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  };
}

type ResultRow = Prisma.test_run_resultsGetPayload<object>;

interface CaseGroup {
  test_case_number: string;
  test_scenario: string;
  test_page_area: string;
  steps: {
    test_step_number: number;
    step_details: string;
    expected_output: string;
    test_data: string | null;
    step_action: Prisma.JsonValue;
    row: ResultRow;
  }[];
}

@Injectable()
export class ResultsService {
  private readonly logger = new Logger(ResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  // ---------------------------------------------------------------- review

  /** Asks Claude for a verdict per executed case, in batches. */
  async review(runId: string) {
    const run = await this.requireCompletedRun(runId);
    try {
      assertApiKeySet();
    } catch (err) {
      throw new ServiceUnavailableException((err as Error).message);
    }
    const groups = (await this.loadCases(runId)).filter(
      (g) =>
        deterministicOutcome(g.steps.map((s) => s.row.result)) !==
        'not_executed',
    );
    if (groups.length === 0) {
      throw new ConflictException('No executed test cases to review.');
    }

    const client = new ClaudeJsonClient();
    const warnings: string[] = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let model = client.model;
    let reviewed = 0;
    for (let i = 0; i < groups.length; i += REVIEW_BATCH_SIZE) {
      const batch = groups.slice(i, i + REVIEW_BATCH_SIZE);
      const numbers = batch.map((g) => g.test_case_number);
      const content = await this.batchContent(run.url, batch, warnings);

      let reply;
      try {
        reply = await client.requestJson({
          system: SYSTEM_PROMPT,
          content,
          schema: verdictSchema(numbers),
          maxTokens: MAX_TOKENS,
        });
      } catch (err) {
        if (err instanceof ClaudeError) {
          this.logger.warn(`Run ${runId}: review failed: ${err.message}`);
          const rawKey =
            err.rawReply !== undefined
              ? await preserveRawReply(
                  this.storage,
                  this.logger,
                  runId,
                  'review',
                  err.message,
                  {
                    rawReply: err.rawReply,
                    model: err.model,
                    usage: err.usage,
                  },
                )
              : undefined;
          throw new BadGatewayException({
            message: `${err.message}${reviewed ? ` (${reviewed} cases were already reviewed and kept.)` : ''}`,
            error: 'Bad Gateway',
            statusCode: 502,
            run_id: runId,
            ...(rawKey && { raw_reply_key: rawKey }),
          });
        }
        throw err;
      }
      model = reply.model;
      usage.input_tokens += reply.usage.input_tokens;
      usage.output_tokens += reply.usage.output_tokens;

      try {
        const result = validateVerdicts(reply.parsed, numbers);
        warnings.push(...result.warnings);
        await this.storeVerdicts(runId, result.verdicts);
        reviewed += result.verdicts.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const rawKey = await preserveRawReply(
          this.storage,
          this.logger,
          runId,
          'review',
          `Processing the review failed: ${message}`,
          { rawReply: reply.rawReply, model: reply.model, usage: reply.usage },
        );
        throw new BadGatewayException({
          message: `Claude replied, but the review could not be stored: ${message}`,
          error: 'Bad Gateway',
          statusCode: 502,
          run_id: runId,
          ...(rawKey && { raw_reply_key: rawKey }),
        });
      }
    }
    this.logger.log(
      `Run ${runId}: reviewed ${reviewed} cases in ${Math.ceil(groups.length / REVIEW_BATCH_SIZE)} requests ` +
        `(input=${usage.input_tokens}, output=${usage.output_tokens} tokens)`,
    );
    return {
      ...(await this.list(runId)),
      review: {
        model,
        requests: Math.ceil(groups.length / REVIEW_BATCH_SIZE),
        cases_reviewed: reviewed,
        usage,
        warnings,
      },
    };
  }

  private async batchContent(
    startUrl: string,
    batch: CaseGroup[],
    warnings: string[],
  ): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: 'text', text: `Page under test (starting URL): ${startUrl}` },
    ];
    for (const g of batch) {
      content.push({
        type: 'text',
        text: `Test case ${g.test_case_number}:\n${JSON.stringify({
          test_case_number: g.test_case_number,
          page_area: g.test_page_area,
          scenario: g.test_scenario,
          steps: g.steps.map((s) => ({
            step: s.test_step_number,
            details: s.step_details,
            expected_output: s.expected_output,
            test_data: s.test_data ?? '',
            action: s.step_action,
            result: s.row.result,
            failure_reason: s.row.execution_error ?? '',
          })),
        })}`,
      });
      const key = g.steps.find((s) => s.row.screenshot)?.row.screenshot;
      if (!key) {
        content.push({
          type: 'text',
          text: `(No screenshot for ${g.test_case_number}.)`,
        });
        continue;
      }
      try {
        const image = screenshotBlock(await this.storage.read(key));
        if ('block' in image) {
          content.push({
            type: 'text',
            text: `Screenshot of ${g.test_case_number}:`,
          });
          content.push(image.block);
        } else {
          warnings.push(`${g.test_case_number}: ${image.warning}`);
          content.push({
            type: 'text',
            text: `(Screenshot of ${g.test_case_number} too large to send.)`,
          });
        }
      } catch {
        warnings.push(`${g.test_case_number}: screenshot could not be read.`);
        content.push({
          type: 'text',
          text: `(Screenshot of ${g.test_case_number} unavailable.)`,
        });
      }
    }
    return content;
  }

  private async storeVerdicts(runId: string, verdicts: CaseVerdict[]) {
    await this.prisma.$transaction(
      verdicts.map((v) =>
        this.prisma.test_run_results.updateMany({
          where: { test_run_id: runId, test_case_number: v.test_case_number },
          data: {
            ai_proposed_result: v.proposed_result,
            ai_reason: v.reason,
            ai_suggested_severity: v.suggested_severity,
            ai_bug_title: v.bug_title,
          },
        }),
      ),
    );
  }

  // ---------------------------------------------------------- confirmation

  /** Confirms or overrides the result of one case. */
  async confirm(runId: string, caseNumber: string, input: Confirmation) {
    await this.requireCompletedRun(runId);
    const group = (await this.loadCases(runId)).find(
      (g) => g.test_case_number === caseNumber,
    );
    if (!group) {
      throw new NotFoundException(
        `No results for ${caseNumber} in run ${runId}.`,
      );
    }
    await this.writeConfirmation(runId, group, input);
    await this.updateReviewedAt(runId);
    const sheet = await this.list(runId);
    return sheet.cases.find((c) => c.test_case_number === caseNumber)!;
  }

  /** Confirms every unconfirmed case where execution and Claude agree. */
  async confirmAllAsProposed(runId: string) {
    await this.requireCompletedRun(runId);
    const groups = await this.loadCases(runId);
    let confirmed = 0;
    for (const g of groups) {
      const first = g.steps[0].row;
      const deterministic = deterministicOutcome(
        g.steps.map((s) => s.row.result),
      );
      const ai = first.ai_proposed_result as 'pass' | 'fail' | null;
      if (
        !canAutoConfirm({
          deterministic,
          ai,
          aiSeverity: first.ai_suggested_severity,
          confirmed: first.user_confirmed_result,
        })
      ) {
        continue;
      }
      await this.writeConfirmation(runId, g, {
        user_confirmed_result: ai!,
        ...(ai === 'fail' && { bug_severity: first.ai_suggested_severity }),
      });
      confirmed++;
    }
    await this.updateReviewedAt(runId);
    return { ...(await this.list(runId)), confirmed_now: confirmed };
  }

  private async writeConfirmation(
    runId: string,
    group: CaseGroup,
    input: Confirmation,
  ) {
    const rows = group.steps.map((s) => s.row);
    // Bug fields live on the first failing step row, else the first row.
    const bugRow = rows.find((r) => r.result === 'fail') ?? rows[0];
    let resolved;
    try {
      resolved = resolveConfirmation(input, {
        confirmed: rows[0].user_confirmed_result,
        bug_severity: bugRow.bug_severity,
        bug_id: bugRow.bug_id,
        bug_status: bugRow.bug_status,
        qa_comments: bugRow.qa_comments,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    await this.prisma.$transaction(async (tx) => {
      let bugId = resolved.bug_id;
      if (resolved.needsBugId) bugId = await this.nextBugId(tx);
      await tx.test_run_results.updateMany({
        where: { test_run_id: runId, test_case_number: group.test_case_number },
        data: {
          user_confirmed_result: resolved.confirmed,
          bug_severity: null,
          bug_id: null,
          bug_status: null,
          qa_comments: null,
        },
      });
      await tx.test_run_results.update({
        where: { id: bugRow.id },
        data: {
          bug_severity: resolved.bug_severity,
          bug_id: bugId,
          bug_status: resolved.bug_status,
          qa_comments: resolved.qa_comments,
        },
      });
    });
  }

  /** Next id of the global BUG-0001 sequence. */
  private async nextBugId(tx: Prisma.TransactionClient): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BUG_NUMBER_LOCK_KEY})`;
    const [{ max }] = await tx.$queryRaw<{ max: number }[]>`
      SELECT COALESCE(MAX(CAST(SUBSTRING(bug_id FROM 5) AS INTEGER)), 0)::int AS max
      FROM test_run_results
      WHERE bug_id ~ '^BUG-[0-9]+$'`;
    return `BUG-${String(max + 1).padStart(4, '0')}`;
  }

  /** reviewed_at is set only while every executed case is confirmed. */
  private async updateReviewedAt(runId: string) {
    const groups = await this.loadCases(runId);
    const all =
      groups.length > 0 &&
      groups.every((g) => g.steps[0].row.user_confirmed_result !== null);
    const run = await this.prisma.test_runs.findUniqueOrThrow({
      where: { id: runId },
      select: { reviewed_at: true },
    });
    if (all && !run.reviewed_at) {
      await this.prisma.test_runs.update({
        where: { id: runId },
        data: { reviewed_at: new Date() },
      });
    } else if (!all && run.reviewed_at) {
      await this.prisma.test_runs.update({
        where: { id: runId },
        data: { reviewed_at: null },
      });
    }
  }

  // ------------------------------------------------------------------ read

  async list(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    const groups = await this.loadCases(runId);
    const cases = groups.map((g) => {
      const rows = g.steps.map((s) => s.row);
      const first = rows[0];
      const bugRow = rows.find((r) => r.result === 'fail') ?? first;
      const deterministic = deterministicOutcome(rows.map((r) => r.result));
      const failed = rows.find((r) => r.result === 'fail');
      const ai = first.ai_proposed_result as 'pass' | 'fail' | null;
      const confirmed = first.user_confirmed_result;
      return {
        test_case_number: g.test_case_number,
        test_scenario: g.test_scenario,
        test_page_area: g.test_page_area,
        deterministic,
        failure: failed
          ? { step: failed.test_step_number, reason: failed.execution_error }
          : null,
        ai: ai
          ? {
              result: ai,
              reason: first.ai_reason,
              suggested_severity: first.ai_suggested_severity,
              bug_title: first.ai_bug_title,
            }
          : null,
        confirmed_result: confirmed,
        bug_severity: bugRow.bug_severity,
        bug_id: bugRow.bug_id,
        bug_status: bugRow.bug_status,
        qa_comments: bugRow.qa_comments,
        screenshot: rows.find((r) => r.screenshot)?.screenshot ?? null,
        needs_attention: needsAttention({ deterministic, ai, confirmed }),
        steps: g.steps.map((s) => ({
          test_step_number: s.test_step_number,
          step_details: s.step_details,
          expected_output: s.expected_output,
          result: s.row.result,
          execution_error: s.row.execution_error,
        })),
      };
    });
    return {
      run_id: runId,
      execution_status: run.execution_status ?? 'not_started',
      reviewed_at: run.reviewed_at,
      summary: {
        cases: cases.length,
        confirmed: cases.filter((c) => c.confirmed_result !== null).length,
        proposed: cases.filter((c) => c.ai !== null).length,
        needs_attention: cases.filter((c) => c.needs_attention).length,
      },
      cases,
    };
  }

  private async requireCompletedRun(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    if (isExecutionActive(run.execution_status)) {
      throw new ConflictException(
        'The tests are still running. Wait until they finish.',
      );
    }
    if (run.execution_status !== 'completed') {
      throw new ConflictException(
        'There is no completed execution to review. Run the tests first.',
      );
    }
    return run;
  }

  private async loadCases(runId: string): Promise<CaseGroup[]> {
    const rows = await this.prisma.test_run_results.findMany({
      where: { test_run_id: runId },
      include: {
        test_case: {
          select: {
            test_scenario: true,
            test_page_area: true,
            step_details: true,
            expected_output: true,
            test_data: true,
            step_action: true,
          },
        },
      },
      orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
    });
    const groups = new Map<string, CaseGroup>();
    for (const { test_case, ...row } of rows) {
      let g = groups.get(row.test_case_number);
      if (!g) {
        g = {
          test_case_number: row.test_case_number,
          test_scenario: test_case.test_scenario,
          test_page_area: test_case.test_page_area,
          steps: [],
        };
        groups.set(row.test_case_number, g);
      }
      g.steps.push({
        test_step_number: row.test_step_number,
        step_details: test_case.step_details,
        expected_output: test_case.expected_output,
        test_data: test_case.test_data,
        step_action: test_case.step_action,
        row,
      });
    }
    return [...groups.values()];
  }
}
