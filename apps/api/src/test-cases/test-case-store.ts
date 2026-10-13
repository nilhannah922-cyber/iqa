/**
 * Shared helpers for writing test cases: the global numbering sequence and
 * the safety net that preserves a paid Claude reply when processing it fails.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StorageProvider } from '../analysis/storage';

/**
 * Persistent numbering: one global sequence TC-0001, TC-0002, ... across all
 * runs and pages. The next number is the highest existing TC-n plus 1, so
 * numbers never depend on run ids and never collide between pages.
 */
const NUMBER_PREFIX = 'TC-';
const NUMBER_WIDTH = 4;
// Serializes numbering across concurrent writers (transaction-scoped lock).
const NUMBERING_LOCK_KEY = 4_203_771;

export function formatTestCaseNumber(n: number): string {
  return `${NUMBER_PREFIX}${String(n).padStart(NUMBER_WIDTH, '0')}`;
}

/** Takes the numbering lock for the rest of the transaction. */
export async function lockNumbering(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NUMBERING_LOCK_KEY})`;
}

/**
 * Returns `count` new consecutive test case numbers. Call lockNumbering first
 * in the same transaction, after deleting rows whose numbers may be reused.
 */
export async function nextTestCaseNumbers(
  tx: Prisma.TransactionClient,
  count: number,
): Promise<string[]> {
  const [{ max }] = await tx.$queryRaw<{ max: number }[]>`
    SELECT COALESCE(MAX(CAST(SUBSTRING(test_case_number FROM ${NUMBER_PREFIX.length + 1}::int) AS INTEGER)), 0)::int AS max
    FROM test_cases
    WHERE test_case_number ~ ${`^${NUMBER_PREFIX}[0-9]+$`}`;
  return Array.from({ length: count }, (_, i) =>
    formatTestCaseNumber(max + i + 1),
  );
}

/**
 * Writes Claude's raw reply to storage under analysis/<run>/<kind>-raw-<ts>.json
 * so a paid result is never lost when validation or saving fails. Returns the
 * storage key (also logged), or undefined if even that write failed. Never
 * contains secrets: only the reason, model, token counts and reply text.
 */
export async function preserveRawReply(
  storage: StorageProvider,
  logger: Logger,
  runId: string,
  kind: string,
  reason: string,
  reply: {
    rawReply: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
  },
): Promise<string | undefined> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `analysis/${runId}/${kind}-raw-${timestamp}.json`;
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
    await storage.save(key, JSON.stringify(record, null, 2) + '\n');
    logger.error(
      `Run ${runId}: ${reason} Claude's raw reply was saved to storage key ${key}`,
    );
    return key;
  } catch (err) {
    logger.error(
      `Run ${runId}: ${reason} Saving Claude's raw reply also failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
