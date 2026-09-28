import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candidate } from '../../domain/candidate.js';
import { orderCandidates } from '../../domain/candidate.js';
import type { CandidateStore } from '../../ports/candidate.js';

/** Writes run under the controller lock; atomic replacement keeps read-only inspection safe. */
export class FileCandidateStore implements CandidateStore {
  private root: string;
  constructor(dataDir: string) { this.root = join(dataDir, 'candidates'); }
  private valid(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid candidate ID.'); }
  async read(id: string): Promise<Candidate | undefined> {
    this.valid(id);
    try { return JSON.parse(await readFile(join(this.root, id + '.json'), 'utf8')) as Candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async list(): Promise<Candidate[]> {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const items = await Promise.all(names.filter(name => /^[a-f0-9]{24}\.json$/.test(name))
      .map(name => this.read(name.slice(0, -5))));
    return orderCandidates(items.filter((item): item is Candidate => !!item));
  }
  async save(candidate: Candidate): Promise<void> {
    this.valid(candidate.id);
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, candidate.id + '.' + randomUUID() + '.tmp');
    const file = await open(temp, 'wx');
    try { await file.writeFile(JSON.stringify(candidate, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(this.root, candidate.id + '.json'));
  }
}
