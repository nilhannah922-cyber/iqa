import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Minimal file storage abstraction (PROJECT_SPEC.md Section 9).
 * Keys are forward-slash relative paths, e.g. "analysis/<timestamp>/page.png".
 * Callers persist keys, never locations, so a local-disk implementation can
 * later be swapped for S3 without changing callers or stored data.
 */
export interface StorageProvider {
  /** Saves data under the key and returns the key. */
  save(key: string, data: Buffer | string): Promise<string>;
  /** Resolves a key to where the file can be read (local path or URL). */
  resolve(key: string): string;
}

/** Repo root, resolved from apps/api/src/analysis (or apps/api/dist/analysis). */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export class LocalDiskStorage implements StorageProvider {
  constructor(
    private readonly rootDir: string = resolve(REPO_ROOT, 'storage'),
  ) {}

  async save(key: string, data: Buffer | string): Promise<string> {
    const target = this.resolve(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return key;
  }

  resolve(key: string): string {
    const target = resolve(this.rootDir, key);
    if (!target.startsWith(this.rootDir + sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return target;
  }
}
