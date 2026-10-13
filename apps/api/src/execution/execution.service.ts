/**
 * Step 10: execution engine. A BullMQ queue "execution" with one in-process
 * worker (concurrency 1) runs an approved test case sheet in headless
 * Chromium, deterministically (no Claude), and stores one result row per step
 * plus one screenshot per case.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Browser, chromium } from 'playwright';
import type { StorageProvider } from '../analysis/storage';
import { STORAGE } from '../analysis/storage.token';
import { PrismaService } from '../prisma/prisma.service';
import type { StepAction } from '../test-cases/step-actions';
import { isExecutionActive } from './execution-guard';
import { ExecCase, StepOutcome, cleanError, runCase } from './step-runner';

export const EXECUTION_QUEUE = 'execution';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const REDIS_TIMEOUT_MS = 3_000;

export type ExecutionStatus =
  'not_started' | 'queued' | 'running' | 'completed' | 'failed';

interface ExecutionJobData {
  runId: string;
}

const RUN_ID = /^[a-z0-9]{1,64}$/i;
const CASE_NUMBER = /^TC-\d{1,8}$/;

export function screenshotKey(runId: string, caseNumber: string): string {
  if (!RUN_ID.test(runId) || !CASE_NUMBER.test(caseNumber)) {
    throw new BadRequestException('Invalid run id or test case number.');
  }
  return `execution/${runId}/${caseNumber}.png`;
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

@Injectable()
export class ExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly redisUrl =
    process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
  private queue?: Queue<ExecutionJobData>;
  private worker?: Worker<ExecutionJobData>;
  /** Fails fast while Redis is down (used to answer 503 instead of hanging). */
  private probe?: Redis;
  private lastRedisError = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  async onModuleInit() {
    await this.recoverInterrupted();
    const connection = { url: this.redisUrl, maxRetriesPerRequest: null };
    this.probe = new Redis(this.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => 2_000,
    });
    this.probe.on('error', (err) => this.logRedisError(err));
    this.queue = new Queue<ExecutionJobData>(EXECUTION_QUEUE, { connection });
    this.queue.on('error', (err) => this.logRedisError(err));
    this.worker = new Worker<ExecutionJobData>(
      EXECUTION_QUEUE,
      (job) => this.process(job),
      { connection, concurrency: 1, maxStalledCount: 0 },
    );
    this.worker.on('error', (err) => this.logRedisError(err));
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Execution job ${job?.id} failed: ${cleanError(err)}`),
    );
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.probe?.disconnect();
  }

  private logRedisError(err: unknown) {
    // Redis being down makes ioredis retry constantly; log at most every 30s.
    if (Date.now() - this.lastRedisError < 30_000) return;
    this.lastRedisError = Date.now();
    this.logger.warn(`Redis (${this.redisUrl}) error: ${cleanError(err)}`);
  }

  // ------------------------------------------------------------- endpoints

  /** Queues execution of the run's approved sheet. */
  async start(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
      include: { _count: { select: { test_cases: true } } },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    if (isExecutionActive(run.execution_status)) {
      throw new ConflictException(
        'The test cases of this run are already being executed.',
      );
    }
    if (run._count.test_cases === 0) {
      throw new ConflictException(
        'This run has no test cases to execute. Generate test cases first.',
      );
    }
    if (!run.test_cases_approved_at) {
      throw new ConflictException(
        'Approve the test cases before running them.',
      );
    }
    await this.assertRedisReachable();

    const jobId = `${runId}-${Date.now()}`;
    // Claim the run atomically so two requests cannot both start it.
    const claimed = await this.prisma.test_runs.updateMany({
      where: {
        id: runId,
        OR: [
          { execution_status: null },
          { execution_status: { in: ['completed', 'failed'] } },
        ],
      },
      data: {
        execution_status: 'queued',
        execution_job_id: jobId,
        execution_queued_at: new Date(),
        execution_started_at: null,
        execution_finished_at: null,
        execution_current_case: null,
        execution_error: null,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        'The test cases of this run are already being executed.',
      );
    }
    try {
      await withTimeout(
        this.queue!.add(
          'run-sheet',
          { runId },
          { jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        ),
        REDIS_TIMEOUT_MS,
        'Timed out adding the job to Redis.',
      );
    } catch (err) {
      await this.prisma.test_runs.update({
        where: { id: runId },
        data: {
          execution_status: run.execution_status,
          execution_job_id: run.execution_job_id,
          execution_queued_at: run.execution_queued_at,
          execution_started_at: run.execution_started_at,
          execution_finished_at: run.execution_finished_at,
          execution_error: run.execution_error,
        },
      });
      throw new ServiceUnavailableException(
        `The job queue (Redis at ${this.redisUrl}) is not reachable, so the tests were not started. Start Redis (docker compose up -d redis) and try again. ${cleanError(err)}`,
      );
    }
    this.logger.log(`Run ${runId}: execution queued as job ${jobId}`);
    return this.status(runId);
  }

  async status(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    const [cases, results] = await Promise.all([
      this.prisma.test_cases.findMany({
        where: { test_run_id: runId },
        select: {
          test_case_number: true,
          test_scenario: true,
          test_step_number: true,
        },
        orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
      }),
      this.prisma.test_run_results.findMany({
        where: { test_run_id: runId },
        select: {
          test_case_number: true,
          test_step_number: true,
          result: true,
          execution_error: true,
          duration_ms: true,
          screenshot: true,
        },
        orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
      }),
    ]);

    const byCase = new Map<
      string,
      { test_case_number: string; test_scenario: string; steps: number }
    >();
    for (const c of cases) {
      const entry = byCase.get(c.test_case_number) ?? {
        test_case_number: c.test_case_number,
        test_scenario: c.test_scenario,
        steps: 0,
      };
      entry.steps++;
      byCase.set(c.test_case_number, entry);
    }
    const summary = [...byCase.values()].map((c) => {
      const rows = results.filter(
        (r) => r.test_case_number === c.test_case_number,
      );
      const count = (r: string) => rows.filter((x) => x.result === r).length;
      const failed = rows.find((r) => r.result === 'fail');
      return {
        test_case_number: c.test_case_number,
        test_scenario: c.test_scenario,
        steps: c.steps,
        executed: rows.length > 0,
        passed: count('pass'),
        failed: count('fail'),
        not_executed: count('not_executed'),
        result:
          rows.length === 0
            ? null
            : failed
              ? 'fail'
              : count('pass') === c.steps
                ? 'pass'
                : 'not_executed',
        failure: failed
          ? { step: failed.test_step_number, reason: failed.execution_error }
          : rows.find((r) => r.result === 'not_executed')?.execution_error
            ? {
                step: rows.find((r) => r.result === 'not_executed')!
                  .test_step_number,
                reason: rows.find((r) => r.result === 'not_executed')!
                  .execution_error,
              }
            : null,
        duration_ms: rows.reduce((n, r) => n + (r.duration_ms ?? 0), 0),
        screenshot: rows.find((r) => r.screenshot)?.screenshot ?? null,
      };
    });

    return {
      run_id: runId,
      status: (run.execution_status ?? 'not_started') as ExecutionStatus,
      queued_at: run.execution_queued_at,
      started_at: run.execution_started_at,
      finished_at: run.execution_finished_at,
      error: run.execution_error,
      progress: {
        cases_done: summary.filter((c) => c.executed).length,
        cases_total: summary.length,
        current_case: run.execution_current_case,
      },
      cases: summary,
      results,
    };
  }

  /**
   * Discards the run's results and screenshots and returns the sheet to an
   * editable, unapproved state (also clears any confirmations).
   */
  async discard(runId: string) {
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Analysis run ${runId} not found.`);
    if (isExecutionActive(run.execution_status)) {
      throw new ConflictException(
        "The tests are running; results can't be discarded until they finish.",
      );
    }
    const keys = await this.prisma.test_run_results.findMany({
      where: { test_run_id: runId, screenshot: { not: null } },
      select: { screenshot: true },
      distinct: ['screenshot'],
    });
    const [deleted] = await this.prisma.$transaction([
      this.prisma.test_run_results.deleteMany({
        where: { test_run_id: runId },
      }),
      this.prisma.test_runs.update({
        where: { id: runId },
        data: {
          execution_status: null,
          execution_job_id: null,
          execution_queued_at: null,
          execution_started_at: null,
          execution_finished_at: null,
          execution_current_case: null,
          execution_error: null,
          test_cases_approved_at: null,
          reviewed_at: null,
        },
      }),
    ]);
    let removed = 0;
    for (const { screenshot } of keys) {
      // Only keys this engine wrote for this run; never anything else.
      if (!screenshot?.startsWith(`execution/${runId}/`)) continue;
      await this.storage
        .remove(screenshot)
        .then(() => removed++)
        .catch((err) =>
          this.logger.warn(
            `Could not delete ${screenshot}: ${cleanError(err)}`,
          ),
        );
    }
    this.logger.log(
      `Run ${runId}: discarded ${deleted.count} results and ${removed} screenshots`,
    );
    return this.status(runId);
  }

  /** Streams a case screenshot through the storage provider. */
  async screenshot(runId: string, caseNumber: string) {
    const key = screenshotKey(runId, caseNumber);
    const recorded = await this.prisma.test_run_results.findFirst({
      where: {
        test_run_id: runId,
        test_case_number: caseNumber,
        screenshot: key,
      },
      select: { id: true },
    });
    if (!recorded) {
      throw new NotFoundException(
        `No screenshot for ${caseNumber} in run ${runId}.`,
      );
    }
    let data: Buffer;
    try {
      data = await this.storage.read(key);
    } catch {
      throw new NotFoundException(
        `The screenshot for ${caseNumber} is missing from storage.`,
      );
    }
    return new StreamableFile(data, {
      type: 'image/png',
      disposition: `inline; filename="${caseNumber}.png"`,
    });
  }

  // ---------------------------------------------------------------- worker

  private async process(job: Job<ExecutionJobData>) {
    const { runId } = job.data;
    const run = await this.prisma.test_runs.findUnique({
      where: { id: runId },
    });
    // Ignore stale jobs (e.g. replayed after a restart that marked it failed).
    if (
      !run ||
      run.execution_job_id !== job.id ||
      run.execution_status !== 'queued'
    ) {
      this.logger.warn(`Run ${runId}: ignoring stale execution job ${job.id}`);
      return;
    }

    const rows = await this.prisma.test_cases.findMany({
      where: { test_run_id: runId },
      select: {
        test_case_number: true,
        test_step_number: true,
        step_action: true,
      },
      orderBy: [{ test_case_number: 'asc' }, { test_step_number: 'asc' }],
    });
    const cases: ExecCase[] = [];
    for (const r of rows) {
      let c = cases.find((x) => x.test_case_number === r.test_case_number);
      if (!c) {
        c = { test_case_number: r.test_case_number, steps: [] };
        cases.push(c);
      }
      c.steps.push({
        test_step_number: r.test_step_number,
        step_action: (r.step_action ?? { action: '' }) as unknown as StepAction,
      });
    }

    // A new execution replaces the previous results of this run.
    await this.prisma.$transaction([
      this.prisma.test_run_results.deleteMany({
        where: { test_run_id: runId },
      }),
      this.prisma.test_runs.update({
        where: { id: runId },
        data: { execution_status: 'running', execution_started_at: new Date() },
      }),
    ]);
    this.logger.log(`Run ${runId}: executing ${cases.length} test cases`);

    let browser: Browser | null = null;
    const done = new Set<string>();
    try {
      for (const c of cases) {
        await this.prisma.test_runs.update({
          where: { id: runId },
          data: { execution_current_case: c.test_case_number },
        });
        let outcomes: StepOutcome[];
        let screenshot: Buffer | null = null;
        try {
          if (!browser?.isConnected()) {
            await browser?.close().catch(() => undefined);
            browser = await chromium.launch({ headless: true });
          }
          const outcome = await runCase(browser, run.url, c);
          outcomes = outcome.steps;
          screenshot = outcome.screenshot;
        } catch (err) {
          // The case never started or the browser crashed mid-case.
          const reason = `Not run: ${cleanError(err)}`;
          this.logger.error(`Run ${runId} ${c.test_case_number}: ${reason}`);
          outcomes = c.steps.map((s) => ({
            test_step_number: s.test_step_number,
            result: 'not_executed',
            error: reason,
            duration_ms: null,
          }));
        }
        let key: string | null = null;
        if (screenshot) {
          try {
            key = await this.storage.save(
              screenshotKey(runId, c.test_case_number),
              screenshot,
            );
          } catch (err) {
            this.logger.error(
              `Run ${runId} ${c.test_case_number}: screenshot not saved: ${cleanError(err)}`,
            );
          }
        }
        await this.saveResults(runId, c.test_case_number, outcomes, key);
        done.add(c.test_case_number);
      }
      await this.prisma.test_runs.update({
        where: { id: runId },
        data: {
          execution_status: 'completed',
          execution_finished_at: new Date(),
          execution_current_case: null,
        },
      });
      this.logger.log(`Run ${runId}: execution completed`);
    } catch (err) {
      const reason = `Execution stopped: ${cleanError(err)}`;
      this.logger.error(`Run ${runId}: ${reason}`);
      await this.failRun(runId, reason, cases, done).catch(() => undefined);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async saveResults(
    runId: string,
    caseNumber: string,
    outcomes: StepOutcome[],
    screenshot: string | null,
  ) {
    const data: Prisma.test_run_resultsCreateManyInput[] = outcomes.map(
      (o) => ({
        test_run_id: runId,
        test_case_number: caseNumber,
        test_step_number: o.test_step_number,
        result: o.result,
        execution_error: o.error,
        duration_ms: o.duration_ms,
        screenshot,
      }),
    );
    await this.prisma.test_run_results.createMany({
      data,
      skipDuplicates: true,
    });
  }

  /** Marks the run failed and every case without results not_executed. */
  private async failRun(
    runId: string,
    reason: string,
    cases?: ExecCase[],
    done?: Set<string>,
  ) {
    const all =
      cases ??
      (
        await this.prisma.test_cases.findMany({
          where: { test_run_id: runId },
          select: { test_case_number: true, test_step_number: true },
        })
      ).reduce<ExecCase[]>((acc, r) => {
        let c = acc.find((x) => x.test_case_number === r.test_case_number);
        if (!c) {
          c = { test_case_number: r.test_case_number, steps: [] };
          acc.push(c);
        }
        c.steps.push({
          test_step_number: r.test_step_number,
          step_action: { action: 'goto' },
        });
        return acc;
      }, []);
    for (const c of all) {
      if (done?.has(c.test_case_number)) continue;
      await this.saveResults(
        runId,
        c.test_case_number,
        c.steps.map((s) => ({
          test_step_number: s.test_step_number,
          result: 'not_executed',
          error: `Not run: ${reason}`,
          duration_ms: null,
        })),
        null,
      );
    }
    await this.prisma.test_runs.update({
      where: { id: runId },
      data: {
        execution_status: 'failed',
        execution_error: reason,
        execution_finished_at: new Date(),
        execution_current_case: null,
      },
    });
  }

  /** On startup, no run may stay queued/running from a previous process. */
  private async recoverInterrupted() {
    const stuck = await this.prisma.test_runs.findMany({
      where: { execution_status: { in: ['queued', 'running'] } },
      select: { id: true, execution_status: true },
    });
    for (const { id, execution_status } of stuck) {
      this.logger.warn(
        `Run ${id}: execution was interrupted; marking it failed`,
      );
      if (execution_status === 'queued') {
        // Never started: keep any previous results, just release the run.
        await this.prisma.test_runs.update({
          where: { id },
          data: {
            execution_status: 'failed',
            execution_error:
              'The API stopped before the queued execution started. Run the tests again.',
            execution_finished_at: new Date(),
          },
        });
        continue;
      }
      await this.failRun(
        id,
        'The API stopped before the execution finished. Run the tests again.',
      );
    }
  }

  private async assertRedisReachable() {
    try {
      if (this.probe!.status === 'wait') {
        await withTimeout(
          this.probe!.connect(),
          REDIS_TIMEOUT_MS,
          'connect timeout',
        );
      }
      await withTimeout(this.probe!.ping(), REDIS_TIMEOUT_MS, 'ping timeout');
    } catch (err) {
      throw new ServiceUnavailableException(
        `The job queue (Redis at ${this.redisUrl}) is not reachable, so the tests were not started. Start Redis (docker compose up -d redis) and try again. (${cleanError(err)})`,
      );
    }
  }
}
