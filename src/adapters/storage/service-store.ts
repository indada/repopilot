import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { taskId } from '../../domain/identity.js';
import type { EventReceipt, ProgressMessage, QueuedEvent, ServiceControl, ServiceEvent, ServiceLedger } from '../../domain/service.js';
import type { ServiceStore } from '../../ports/service.js';

/** One controller owns receipts/ledgers; the HTTP receiver may append immutable deliveries concurrently. */
export class FileServiceStore implements ServiceStore {
  private root: string;
  private append: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.root = join(dataDir, 'service'); }
  private valid(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid service record ID.'); }
  private async read<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.root, name), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async names() {
    return readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  }
  private async write(name: string, value: unknown, exclusive = false) {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, name + '.' + randomUUID() + '.tmp'), target = join(this.root, name);
    const file = await open(temp, 'wx');
    try {
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
      if (exclusive) await link(temp, target); else await rename(temp, target);
    } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  enqueue(event: ServiceEvent, maxPending: number): Promise<'created' | 'duplicate'> {
    this.valid(event.id);
    const operation = this.append.then(async () => {
      const name = event.id + '.event.json', previous = await this.read<ServiceEvent>(name);
      if (previous) {
        if (previous.repository !== event.repository || previous.digest !== event.digest)
          throw new Error('Delivery ID was reused with different evidence.');
        return 'duplicate' as const;
      }
      if ((await this.events(event.repository)).filter(item => !item.receipt || ['pending', 'processing'].includes(item.receipt.status)).length >= maxPending)
        throw new Error('Service event queue is full.');
      try { await this.write(name, event, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const recorded = await this.read<ServiceEvent>(name);
        if (recorded?.repository !== event.repository || recorded.digest !== event.digest)
          throw new Error('Delivery ID was reused with different evidence.');
        return 'duplicate' as const;
      }
      return 'created' as const;
    });
    this.append = operation.catch(() => undefined); return operation;
  }
  async events(repository: string): Promise<QueuedEvent[]> {
    const entries: QueuedEvent[] = [];
    for (const name of (await this.names()).filter(item => /^[a-f0-9]{24}\.event\.json$/.test(item))) {
      const event = await this.read<ServiceEvent>(name);
      if (event?.repository === repository) entries.push({ event, receipt: await this.read<EventReceipt>(event.id + '.receipt.json') });
    }
    return entries.sort((a, b) => a.event.receivedAt.localeCompare(b.event.receivedAt) || a.event.id.localeCompare(b.event.id));
  }
  async receipt(id: string, value: EventReceipt) { this.valid(id); await this.write(id + '.receipt.json', value); }
  async prune(repository: string, before: string) {
    let count = 0;
    for (const item of await this.events(repository)) if (item.receipt?.status === 'completed' && item.receipt.updatedAt < before) {
      await unlink(join(this.root, item.event.id + '.event.json'));
      await unlink(join(this.root, item.event.id + '.receipt.json')); count++;
    }
    return count;
  }
  ledger(repository: string) { return this.read<ServiceLedger>(taskId(repository) + '.ledger.json'); }
  saveLedger(value: ServiceLedger) { return this.write(taskId(value.repository) + '.ledger.json', value); }
  control(repository: string) { return this.read<ServiceControl>(taskId(repository) + '.control.json'); }
  requestControl(repository: string, action: 'pause' | 'resume') {
    return this.write(taskId(repository) + '.control.json', { id: randomUUID(), action, at: new Date().toISOString() });
  }
  async progress(repository: string) {
    const messages: ProgressMessage[] = [];
    for (const name of (await this.names()).filter(item => /^[a-f0-9]{24}\.progress\.json$/.test(item))) {
      const message = await this.read<ProgressMessage>(name); if (message?.repository === repository) messages.push(message);
    }
    return messages;
  }
  async saveProgress(value: ProgressMessage) { this.valid(value.id); await this.write(value.id + '.progress.json', value); }
}
