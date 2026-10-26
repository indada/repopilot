import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { taskId } from '../../domain/identity.js';
import type { DecisionAdmission, DecisionEvaluation, DecisionObservation, DecisionPolicyState, DecisionPolicyVersion,
  DecisionReview, GovernanceReceipt, GovernanceRequest } from '../../domain/decision-governance.js';
import type { DecisionGovernanceStore } from '../../ports/decision-governance.js';

export class FileDecisionGovernanceStore implements DecisionGovernanceStore {
  private root: string;
  private append: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.root = join(dataDir, 'decision-governance'); }
  private path(id: string, type: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid governance ID.');
    return join(this.root, id + '.' + type + '.json');
  }
  private async read<T>(id: string, type: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(id, type), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async all<T extends { id: string; repository: string }>(repository: string, type: string): Promise<T[]> {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const result: T[] = [];
    for (const name of names.filter(name => new RegExp('^[a-f0-9]{24}\\.' + type + '\\.json$').test(name))) {
      const value = await this.read<T>(name.slice(0, 24), type); if (value?.repository === repository) result.push(value);
    }
    return result;
  }
  private async write(id: string, type: string, value: unknown, immutable = true) {
    const target = this.path(id, type); await mkdir(this.root, { recursive: true });
    const temporary = target + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
      if (!immutable) { await rename(temporary, target); return; }
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = await this.read<unknown>(id, type);
        if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('Immutable governance evidence already exists with different content.');
      }
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  policy(id: string) { return this.read<DecisionPolicyVersion>(id, 'policy'); }
  policies(repository: string) { return this.all<DecisionPolicyVersion>(repository, 'policy'); }
  savePolicy(value: DecisionPolicyVersion) { return this.write(value.id, 'policy', value); }
  review(id: string) { return this.read<DecisionReview>(id, 'review'); }
  reviews(repository: string) { return this.all<DecisionReview>(repository, 'review'); }
  saveReview(value: DecisionReview) { return this.write(value.id, 'review', value); }
  evaluation(id: string) { return this.read<DecisionEvaluation>(id, 'evaluation'); }
  evaluations(repository: string) { return this.all<DecisionEvaluation>(repository, 'evaluation'); }
  saveEvaluation(value: DecisionEvaluation) { return this.write(value.id, 'evaluation', value); }
  observations(repository: string) { return this.all<DecisionObservation>(repository, 'observation'); }
  async saveObservation(value: DecisionObservation) {
    if (!await this.read(value.id, 'observation')) await this.write(value.id, 'observation', value);
  }
  admissions(repository: string) { return this.all<DecisionAdmission>(repository, 'admission'); }
  async saveAdmission(value: DecisionAdmission) {
    if (!await this.read(value.id, 'admission')) await this.write(value.id, 'admission', value);
  }
  policyState(repository: string) { return this.read<DecisionPolicyState>(taskId(repository), 'state'); }
  savePolicyState(value: DecisionPolicyState) { return this.write(taskId(value.repository), 'state', value, false); }
  enqueue(value: GovernanceRequest, maxPending: number) {
    const operation = this.append.then(async () => {
      if (await this.read(value.id, 'request')) { await this.write(value.id, 'request', value); return; }
      if ((await this.requests(value.repository)).filter(item => !item.receipt).length >= maxPending) throw new Error('Decision operator request queue is full.');
      await this.write(value.id, 'request', value);
    });
    this.append = operation.catch(() => undefined); return operation;
  }
  async requests(repository: string) {
    const requests = (await this.all<GovernanceRequest>(repository, 'request'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return Promise.all(requests.map(async request => ({ request, receipt: await this.read<GovernanceReceipt>(request.id, 'receipt') })));
  }
  receipt(id: string, value: GovernanceReceipt) { return this.write(id, 'receipt', value); }
}
