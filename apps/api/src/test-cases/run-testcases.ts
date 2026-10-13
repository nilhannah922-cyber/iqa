/**
 * Generates test cases for an analysis run's approved checklist items, stores
 * them (replacing never-executed cases from a previous generation) and prints
 * them as the 12 display columns plus step_action.
 *
 * Usage (from apps/api):  npm run testcases -- <runId>
 */
import { HttpException } from '@nestjs/common';
import { LocalDiskStorage } from '../analysis/storage';
import { loadEnv } from '../claude/claude-json';
import { PrismaService } from '../prisma/prisma.service';
import { TestCasesService } from './test-cases.service';

async function main() {
  const runId = process.argv[2]?.trim();
  if (!runId) {
    console.error(
      'Error: No run id given. Usage: npm run testcases -- <runId>',
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const prisma = new PrismaService();
  try {
    const service = new TestCasesService(prisma, new LocalDiskStorage());
    console.log(`Generating test cases for run ${runId}...\n`);
    const result = await service.generateForRun(runId);

    let current = '';
    for (const row of result.test_cases) {
      if (row.test_case_number !== current) {
        current = row.test_case_number;
        console.log(
          `\n${row.test_case_number}  [${row.test_page_area}]  ${row.test_scenario}`,
        );
      }
      console.log(
        `  ${row.test_step_number}. ${row.step_details}\n` +
          `     expect: ${row.expected_output}` +
          (row.test_data ? `\n     data:   ${row.test_data}` : '') +
          `\n     action: ${JSON.stringify(row.step_action)}`,
      );
    }

    for (const w of result.warnings) console.warn(`Warning: ${w}`);
    const cases = new Set(result.test_cases.map((r) => r.test_case_number));
    console.log(
      `\n${cases.size} test cases, ${result.test_cases.length} steps ` +
        `(replaced ${result.replaced} previous, kept ${result.kept_executed} executed)`,
    );
    console.log(`Model: ${result.model}`);
    console.log(
      `Tokens: input=${result.usage.input_tokens}, output=${result.usage.output_tokens}`,
    );
  } catch (err) {
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message =
        typeof body === 'object' && body && 'message' in body
          ? body.message
          : err.message;
      console.error(`Error: ${String(message)}`);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
