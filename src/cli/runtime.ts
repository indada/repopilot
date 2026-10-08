import type { Config } from '../domain/config.js';
import type { Agent } from '../ports/agent.js';
import type { GitHub } from '../ports/github.js';
import type { Repository } from '../ports/repository.js';
import type { Runner } from '../ports/runner.js';
import type { Store } from '../ports/store.js';
export interface Runtime {
  config: Config; store: Store; agent?: Agent; runner?: Runner; github: GitHub; repository: Repository;
  signal: AbortSignal;
  onTaskStart?: () => Promise<void>;
}
export interface Output { write(value: string): void; error(value: string): void; }
