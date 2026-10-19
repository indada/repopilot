# Source layout

| Directory | Responsibility |
| --- | --- |
| cli/ | Argument parsing, command handlers, output, configuration loading and dependency assembly |
| application/ | Verification, goal planning/iteration, role handoffs, persistent service dispatch/budgets/progress, Issue queue, PR maintenance, proposals, replay/cancellation and publication |
| domain/ | Types, collaboration/goal schemas, identities, snapshot operations, policies, patch validation and test assessment |
| ports/ | Agent, Runner, task/goal/service stores, model call reservations, Repository, GitHub and automation contracts |
| adapters/codex/ | Codex container execution, SDK entry point and context preparation |
| adapters/decision/ | Controller-side Jev typed-decision HTTP integration and response validation |
| adapters/testing/ | Docker execution and recovery; Node/Vitest, pytest/JUnit XML and Go JSON evidence |
| adapters/github/ | GitHub HTTP, signed Webhook ingress, progress comments and Git-data publication |
| adapters/storage/ | Git operations, snapshot export and filesystem task persistence |
| reporting/ | Human-readable Markdown reports |
| shared/ | Process execution, cancellation and bounded retry primitives |

Dependencies point inward: domain is independent of CLI, adapters and workflow orchestration; ports describe capabilities using domain types; application uses ports. Concrete implementations are wired in cli/bootstrap.ts. Command handlers receive a Runtime of interfaces.

Do not import application from adapters or adapters from application. Avoid barrel exports that obscure dependencies. tests/architecture.test.ts checks layer boundaries, cycles, task identity compatibility and clean-build entry paths.

The public executable stays src/cli.ts → dist/cli.js. Container entry is dist/adapters/codex/entry.js; the trusted test reporter is dist/adapters/testing/node-reporter.js. Build before using Docker execution.

See [architecture](../docs/ARCHITECTURE.md) for verification gates and task state semantics.
