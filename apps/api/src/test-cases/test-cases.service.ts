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
import { ClaudeError, assertApiKeySet } from '../claude/claude-json';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApprovedItem,
  GeneratedCase,
  TestCaseGenerator,
} from './test-case-generator';

/**
 * Persistent numbering: one global sequence TC-0001, TC-0002, ... across all
 * runs and pages. The next number is the highest existing TC-n plus 1, so
 * numbers never depend on run ids and never collide between pages.
 */
const NUMBER_PREFIX = 'TC-';
const NUMBER_WIDTH = 4;
// Serializes numbering across concurrent generations (transaction-scoped lock).
const NUMBERING_LOCK_KEY = 4_203_771;

export function formatTestCaseNumber(n: number): string {
  return `${NUMBER_PREFIX}${String(n).padStart(NUMBER_WIDTH, '0')}`;
}

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

export interface GenerateTestCasesResult {
  run_id: string;
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
            ? await this.preserveRawReply(runId, err.message, {
                rawReply: err.rawReply,
                model: err.model,
                usage: err.usage,
              })
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
      await this.preserveRawReply(
        runId,
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

  async listForRun(
    runId: string,
  ): Promise<{ run_id: string; test_cases: TestCaseRow[] }> {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    return { run_id: runId, test_cases: await this.rowsForRun(runId) };
  }

  /**
   * Writes Claude's raw reply to storage so a paid result is never lost when
   * validation or saving fails. Returns the storage key (also logged), or
   * undefined if even that write failed.
   */
  private async preserveRawReply(
    runId: string,
    reason: string,
    reply: {
      rawReply: string;
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
    },
  ): Promise<string | undefined> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `analysis/${runId}/testcases-raw-${timestamp}.json`;
    const record = {
      run_id: runId,
      saved_at: new Date().toISOString(),
      reason,
      model: reply.model ?? null,
      usage: reply.usage
        ? {
            input_tokens: reply.usage.input_tokens,
            output_tokens: reply.usage.output_tokens,
          }
        : null,
      raw_reply: reply.rawReply,
    };
    try {
      await this.storage.save(key, JSON.stringify(record, null, 2) + '\n');
      this.logger.error(
        `Run ${runId}: ${reason} Claude's raw reply was saved to storage key ${key}`,
      );
      return key;
    } catch (err) {
      this.logger.error(
        `Run ${runId}: ${reason} Saving Claude's raw reply also failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NUMBERING_LOCK_KEY})`;

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

      const [{ max }] = await tx.$queryRaw<{ max: number }[]>`
        SELECT COALESCE(MAX(CAST(SUBSTRING(test_case_number FROM ${NUMBER_PREFIX.length + 1}::int) AS INTEGER)), 0)::int AS max
        FROM test_cases
        WHERE test_case_number ~ ${`^${NUMBER_PREFIX}[0-9]+$`}`;

      const rows: Prisma.test_casesCreateManyInput[] = cases.flatMap((c, i) => {
        const number = formatTestCaseNumber(max + i + 1);
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
      return { replaced: removable.length, kept: executed.size };
    });
  }
}
