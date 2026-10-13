/**
 * Analyzes a page, asks Claude for a functionality checklist and prints it.
 *
 * Usage (from apps/api):  npm run checklist -- https://example.com
 */
import { AnalysisError, analyzePage } from '../analysis/analyze-page';
import { LocalDiskStorage } from '../analysis/storage';
import { ChecklistError, ChecklistService, loadEnv } from './checklist.service';

async function main() {
  try {
    loadEnv();
    const service = new ChecklistService(); // fails fast if the key is unset

    const storage = new LocalDiskStorage();
    const { analysis, screenshot, screenshotKey } = await analyzePage(
      process.argv[2],
      storage,
    );
    console.log(`Analyzed ${analysis.final_url}`);
    console.log(`Screenshot: ${storage.resolve(screenshotKey)}`);
    console.log(`Asking ${service.model} for a checklist...\n`);

    const result = await service.generate(analysis, screenshot);
    console.log(JSON.stringify({ items: result.items }, null, 2));

    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);

    const u = result.usage;
    console.log(`\nModel: ${result.model}`);
    console.log(
      `Tokens: input=${u.input_tokens}, output=${u.output_tokens}` +
        `, cache_read=${u.cache_read_input_tokens ?? 0}` +
        `, cache_write=${u.cache_creation_input_tokens ?? 0}`,
    );
  } catch (err) {
    if (err instanceof AnalysisError || err instanceof ChecklistError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exitCode = 1;
  }
}

void main();
