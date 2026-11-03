/**
 * One-off: renames execution screenshots after migration
 * 20261103120000_per_sheet_numbering, using its mapping table
 * _bak_20261103_case_number_map (old -> new number per run).
 *
 *   npm run renumber-screenshots              old names -> new names
 *   npm run renumber-screenshots -- --reverse new names -> old names (rollback)
 *   npm run renumber-screenshots -- --dry-run show what would happen
 *
 * Safe and re-runnable: every file is first COPIED into a staging folder and
 * verified; originals are deleted only after all copies succeeded; an
 * existing target that is not part of the mapping is never overwritten.
 * Works on the local storage root (STORAGE_ROOT or <repo>/storage).
 */
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LocalDiskStorage } from '../analysis/storage';
import { loadEnv } from '../claude/claude-json';
import { PrismaService } from '../prisma/prisma.service';

interface MapRow {
  test_run_id: string;
  old_number: string;
  new_number: string;
}

const STAGING = '.renumber-staging';
/** Present (in the storage root) once the forward rename has completed. */
const DONE_MARKER = 'execution/.renumbered-20261103';

async function main() {
  const reverse = process.argv.includes('--reverse');
  const dryRun = process.argv.includes('--dry-run');
  loadEnv();
  const prisma = new PrismaService();
  const storage = new LocalDiskStorage();
  try {
    // Old and new names overlap, so the direction already applied must be
    // remembered: a marker file records a completed forward rename.
    const marker = storage.resolve(DONE_MARKER);
    const forwardDone = existsSync(marker);
    if (!reverse && forwardDone) {
      console.log('Already done: the screenshots were renamed before.');
      return;
    }
    if (reverse && !forwardDone) {
      console.log('Nothing to reverse: the forward rename has not been done.');
      return;
    }
    const rows = await prisma.$queryRaw<MapRow[]>`
      SELECT "test_run_id", "old_number", "new_number"
      FROM "_bak_20261103_case_number_map"
      WHERE "old_number" <> "new_number"
      ORDER BY "test_run_id", "old_number"`;
    const moves = rows.map((r) => ({
      run: r.test_run_id,
      from: storage.resolve(
        `execution/${r.test_run_id}/${reverse ? r.new_number : r.old_number}.png`,
      ),
      to: storage.resolve(
        `execution/${r.test_run_id}/${reverse ? r.old_number : r.new_number}.png`,
      ),
    }));
    const sources = new Set(moves.map((m) => m.from));
    const todo = moves.filter((m) => existsSync(m.from));
    const missing = moves.length - todo.length;
    console.log(
      `${reverse ? 'Reverse' : 'Forward'}: ${moves.length} mapped numbers, ${todo.length} files to rename, ${missing} without a file (nothing to do).`,
    );
    for (const m of todo) {
      if (existsSync(m.to) && !sources.has(m.to)) {
        throw new Error(
          `Refusing to overwrite ${m.to}: it exists and is not being renamed itself.`,
        );
      }
    }
    if (dryRun) {
      for (const m of todo) console.log(`  ${m.from} -> ${m.to}`);
      return;
    }

    // 1. Copy every file into a staging folder and verify the copy.
    for (const m of todo) {
      const staged = join(dirname(m.to), STAGING, m.to.split(/[\\/]/).pop()!);
      await mkdir(dirname(staged), { recursive: true });
      await copyFile(m.from, staged);
      const [a, b] = await Promise.all([stat(m.from), stat(staged)]);
      if (a.size !== b.size)
        throw new Error(`Copy of ${m.from} is incomplete.`);
    }
    // 2. All copies are safe: remove the originals.
    for (const m of todo) await rm(m.from);
    // 3. Move the staged files into place and remove the staging folders.
    const dirs = new Set<string>();
    for (const m of todo) {
      const stagingDir = join(dirname(m.to), STAGING);
      dirs.add(stagingDir);
      await rename(join(stagingDir, m.to.split(/[\\/]/).pop()!), m.to);
    }
    for (const d of dirs) {
      if ((await readdir(d)).length === 0) await rm(d, { recursive: true });
    }
    if (reverse) await rm(marker, { force: true });
    else {
      await mkdir(dirname(marker), { recursive: true });
      await writeFile(
        marker,
        `renamed ${todo.length} files at ${new Date().toISOString()}
`,
      );
    }
    console.log(`Renamed ${todo.length} screenshot files.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
