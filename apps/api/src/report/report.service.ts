/**
 * Step 12: Full Check report (JSON and Excel) for one run.
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import type { StorageProvider } from '../analysis/storage';
import { STORAGE } from '../analysis/storage.token';
import { PrismaService } from '../prisma/prisma.service';
import {
  ReportStepInput,
  caseOutcomes,
  sheetRows,
  summarize,
} from './report-builder';
import { buildReportXlsx } from './report-xlsx';

const DEFAULT_PUBLIC_API_URL = 'http://localhost:4000';

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /** Base URL used for links that leave the API (e.g. in the Excel file). */
  private get publicApiUrl(): string {
    const fromEnv = process.env.PUBLIC_API_URL?.trim();
    const port = process.env.PORT?.trim();
    return (
      fromEnv || (port ? `http://localhost:${port}` : DEFAULT_PUBLIC_API_URL)
    ).replace(/\/+$/, '');
  }

  screenshotUrl(runId: string, caseNumber: string): string {
    return `${this.publicApiUrl}/analysis/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(caseNumber)}`;
  }

  async report(runId: string) {
    const { run, steps } = await this.load(runId);
    const cases = caseOutcomes(steps);
    const summary = summarize(cases);
    const failed = cases
      .filter((c) => c.confirmed === 'fail')
      .map((c) => ({
        ...c,
        screenshot_url: c.screenshot
          ? this.screenshotUrl(runId, c.test_case_number)
          : null,
      }));
    return {
      run: {
        id: run.id,
        mode: run.mode,
        url: run.url,
        created_at: run.timestamp,
        executed_at: run.execution_finished_at,
        execution_status: run.execution_status,
        reviewed_at: run.reviewed_at,
      },
      summary,
      failed_cases: failed,
      cases: cases.map((c) => ({
        test_case_number: c.test_case_number,
        test_scenario: c.test_scenario,
        confirmed_result: c.confirmed,
        test_case_problem: c.test_case_problem,
        bug_id: c.bug_id,
        bug_severity: c.bug_severity,
      })),
      sheet: sheetRows(steps),
    };
  }

  async xlsx(runId: string, embed: boolean): Promise<StreamableFile> {
    const { run, steps } = await this.load(runId);
    const cases = caseOutcomes(steps);
    let images: Map<string, Buffer> | undefined;
    if (embed) {
      images = new Map();
      for (const c of cases) {
        if (!c.screenshot) continue;
        try {
          images.set(c.test_case_number, await this.storage.read(c.screenshot));
        } catch {
          // A missing file only drops that image; the link stays in the sheet.
        }
      }
    }
    const buffer = await buildReportXlsx({
      runId,
      url: run.url,
      date: run.execution_finished_at ?? run.timestamp,
      finishedAt: run.execution_finished_at,
      reviewedAt: run.reviewed_at,
      summary: summarize(cases),
      rows: sheetRows(steps),
      cases,
      screenshotUrl: (n) => this.screenshotUrl(runId, n),
      images,
    });
    const date = (run.execution_finished_at ?? run.timestamp)
      .toISOString()
      .slice(0, 10);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="iqa-full-check-${date}-${runId}.xlsx"`,
      length: buffer.length,
    });
  }

  private async load(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    if (!run.execution_status || run.execution_status === 'queued') {
      throw new ConflictException(
        'There is no execution for this run yet. Run the tests first.',
      );
    }
    const rows = await this.prisma.test_cases.findMany({
      where: { test_run_id: runId },
      include: { run_results: { where: { test_run_id: runId } } },
      orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
    });
    const steps: ReportStepInput[] = rows.map((r) => {
      const res = r.run_results[0];
      return {
        test_case_number: r.test_case_number,
        test_page_area: r.test_page_area,
        test_scenario: r.test_scenario,
        test_step_number: r.test_step_number,
        step_details: r.step_details,
        expected_output: r.expected_output,
        test_data: r.test_data,
        result: res?.result ?? null,
        execution_error: res?.execution_error ?? null,
        user_confirmed_result: res?.user_confirmed_result ?? null,
        ai_reason: res?.ai_reason ?? null,
        bug_id: res?.bug_id ?? null,
        bug_severity: res?.bug_severity ?? null,
        bug_status: res?.bug_status ?? null,
        qa_comments: res?.qa_comments ?? null,
        screenshot: res?.screenshot ?? null,
      };
    });
    return { run, steps };
  }
}
