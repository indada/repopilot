import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { taskId } from '../../domain/identity.js';
import type { DecisionLedger, DecisionRecord } from '../../domain/decision.js';
import type { DecisionStore } from '../../ports/decision.js';

/** Mutations use the existing exclusive controller lock; inspection remains available during execution. */
export class FileDecisionStore implements DecisionStore {
  private root: string;
  constructor(dataDir: string) { this.root = join(dataDir, 'decisions'); }
  private valid(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid decision ID.'); }
  private async load<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.root, name), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async write(name: string, value: unknown) {
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, name + '.' + randomUUID() + '.tmp'), file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.root, name));
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  read(id: string) { this.valid(id); return this.load<DecisionRecord>(id + '.decision.json'); }
  async list(repository: string) {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const records: DecisionRecord[] = [];
    for (const name of names.filter(value => /^[a-f0-9]{24}\.decision\.json$/.test(value))) {
      const record = await this.load<DecisionRecord>(name); if (record?.repository === repository) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  save(record: DecisionRecord) { this.valid(record.id); return this.write(record.id + '.decision.json', record); }
  ledger(repository: string) { return this.load<DecisionLedger>(taskId(repository) + '.ledger.json'); }
  saveLedger(ledger: DecisionLedger) { return this.write(taskId(ledger.repository) + '.ledger.json', ledger); }
}
