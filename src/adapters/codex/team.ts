import type { AgentRole } from '../../domain/collaboration.js';
import type { Config } from '../../domain/config.js';
import type { describeTestEnvironment } from '../../domain/runner-config.js';
import type { Agent } from '../../ports/agent.js';
import type { ModelCallBudget } from '../../ports/service.js';
import { DockerCodexAgent, SharedAgentBudget } from './docker-agent.js';

/** Role isolation uses separate Codex threads/containers with one controller-owned budget ledger. */
export class CodexAgentTeam implements Agent {
  private agents: Record<AgentRole, DockerCodexAgent>;
  private budget: SharedAgentBudget;
  constructor(private config: Config['agent'], private collaboration: NonNullable<Config['iteration']>['collaboration'],
    private dataDir: string, private testEnvironment?: ReturnType<typeof describeTestEnvironment>, private globalBudget?: ModelCallBudget) {
    if (!collaboration) throw new Error('Collaboration configuration is required.');
    this.budget = new SharedAgentBudget(config.maxCalls, config.maxTokens);
    const create = (role: AgentRole) => new DockerCodexAgent(
      { ...config, model: collaboration.roles[role].model ?? config.model }, dataDir, testEnvironment, this.budget, role, globalBudget);
    this.agents = { planner: create('planner'), tester: create('tester'),
      developer: create('developer'), reviewer: create('reviewer') };
  }
  forRole(role: AgentRole): Agent { return this.agents[role]; }
  forkExecution(): Agent { return new CodexAgentTeam(this.config, this.collaboration, this.dataDir, this.testEnvironment, this.globalBudget); }
  resetBudget() { this.budget.reset(); }
  usage() { return this.budget.usage(); }
  design(...args: Parameters<NonNullable<Agent['design']>>) { return this.agents.planner.design(...args); }
  review(...args: Parameters<Agent['review']>) { return this.agents.reviewer.review(...args); }
  plan(...args: Parameters<Agent['plan']>) { return this.agents.tester.plan(...args); }
  repair(...args: Parameters<Agent['repair']>) { return this.agents.developer.repair(...args); }
}
