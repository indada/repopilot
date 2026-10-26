# Architecture

## Flow

Pinned base/head and description → trusted policy → static + baseline/head semantic review → existing tests → generated frozen tests → stable failure reproduction → bounded source repair → same-case verification and policy recheck → separate branch and draft PR.

The controller owns configuration, credentials, task records and publication. Target code runs only in test containers. The agent receives bounded text context and proposes replacements.

## Layers and dependencies

| Layer | Responsibility |
| --- | --- |
| cli | Commands, configuration loading, output and dependency assembly |
| application | Pipeline, watcher, task management and publication workflows |
| domain | Pure rules, identities, snapshots, patch validation and test evidence |
| ports | Agent, Runner, Store, Repository and GitHub contracts |
| adapters | Codex/Docker, test reporters, GitHub HTTP, Git and filesystem implementations |
| reporting | Markdown summaries |
| shared | Processes, cancellation and retry primitives |

Application depends on domain and ports; concrete adapters are injected by cli/bootstrap.ts. Domain and ports do not import adapters or application. Adapters do not depend on application. The GitHub client uses domain/identity.ts instead of importing the pipeline. Task replay receives Repository and GitHub ports rather than constructing concrete services.

Agent response schema and repair validation live in domain; DockerCodexAgent lives in adapters/codex. Snapshot comparisons are pure domain operations; Git subprocesses and snapshot export are storage adapters. Framework-specific test parsing belongs to testing adapters, while pass/failure assessment belongs to domain.

The small src/cli.ts entry and all command syntax remain stable. Docker entry/reporting paths follow the new layout. Architecture tests enforce dependency directions, absence of cycles, stable task IDs and fresh-build paths. See [source map](../src/README.md).

## State and recovery

Tasks identify repository, PR, base/head, title/body digest, configuration and report schema version. States: running, passed, needs_attention, verified, published, stale, cancelled, error.

Terminal reports deduplicate. Temporary errors retry only after retryAfter and below maxTaskExecutions; interrupted running/cancelled tasks can resume within the same bound. Earlier evidence is archived before rerun. Permanent errors need corrected configuration or inputs. A single controller owns the data directory; after a crash verify the old process stopped before removing its lock.

A freshness monitor aborts in-flight work when PR input changes. SIGINT/SIGTERM and task timeout propagate to Git subprocesses, Docker clients and adapter calls. Container removal runs independently during cleanup. Process crashes may still leave containers.

Operator cancellation writes a separate atomic marker without acquiring the report writer lock. Verification/publication poll it and abort active operations. Cancellation markers persist until explicit resume; new PR inputs get distinct task IDs. List/show expose the request separately from final report state. Rerun adds a random run key to task identity and stores rerunOf; resume keeps the original key/configuration and bounded execution count. Replay metadata stores the local repository path, pinned commits and canonical description. Verification restarts from the beginning; verified publication can resume separately. Remote PR freshness is mandatory for replay.

GitHub GET calls retry selected rate-limit/server failures with bounded exponential waits. Server retry windows beyond the wait budget defer rather than retry early. Writes are not blindly replayed: publication reconstructs the expected tree and checks existing branch/PR content before reuse. A late source update can still leave an unused branch.

## Verification gates

1. Parse structured results. A successful command with zero/all-skipped tests does not pass.
2. Record original base/head cases. Model-generated tests are additional files with scenario mappings.
3. Execute frozen tests on base/head and check identical discovery. Original baseline tests must stay green. Generated base-pass/head-fail cases are regressions; base-fail/head-pass cases qualify as new behavior only with a validated PR requirement quote and explicit scenario type. Both-fail and execution errors require review. Generated tests cannot alter original test outcomes. Mixed new-behavior/regression plans remain eligible when every case has unambiguous evidence.
4. For regressions, repeat head and require identical failing identities and fingerprints. This detects changing failures; it is not statistical proof of non-flakiness.
5. Repair production source only. Recheck static rules, run tests, preserve original base/head/generated case identities, and repeat semantic review against trusted rules.
6. Publish only verified results on still-current input. Git trees preserve executable bits. A matching existing PR must have the exact expected parent/tree.

Semantic review cites exact scoped rule text and code lines. Baseline/head findings are compared with occurrence counts. Expiring exceptions come only from base policy. AST rules match direct/qualified calls and string property accesses, not aliases or whole-program semantics.

## Budgets and context

Each execution has a wall-clock budget, model call count limit and reported-token threshold. The token check occurs after each call; a single call may exceed it. No currency accounting is claimed.

Context batches contain whole changed files and authoritative scoped rules, with related imports/tests where space allows. Omitted related paths are explicit. Oversized individual files fail rather than silently truncate. Full test evidence is local; model requests and Markdown summaries are bounded.

## Scope

Public text repositories, same-repository PRs, one controller with serial task admission and optional bounded DAG parallelism, atomic files instead of SQLite. No fork execution, browser E2E, dependency installation, hosted administration or automatic merge. The controller supports optional Webhook ingress alongside polling and a separate loopback-only read-only console. Containers/reporters are not hostile-code attestation. See SECURITY.md.
## Test environment configuration

`domain/runner-config.ts` validates single-command and multi-command execution contracts. `adapters/testing/environment.ts` owns disposable Docker networks, dependency services, readiness checks and cleanup; `docker-runner.ts` runs commands and aggregates their evidence. The application continues to depend only on the Runner port. Command-scoped case IDs preserve independent evidence across multiple suites, while legacy single-command IDs remain unchanged. See [test environments](TEST-ENVIRONMENTS.md).
## Goal iteration extension

Version 1.3.0 adds a goal workflow above the existing verification pipeline. `IterationStore` saves goal specifications, dependency plans, pinned inputs, cumulative changes, per-criterion attempt counters and model/time reservations under `goals/`. Each step retains its own ordinary evidence report. Recovery consumes a saved verified step before requesting more model work; final publication requires original and all completed-step evidence to remain passing.

The optional Issue queue and PR maintenance loop share the controller lock and goal budgets. PR updates preserve branch ownership, compare current feedback and commits, and use non-force commits. Interrupted updates are reconciled against the complete saved Git tree. Historical experiences are scoped to repository, commit and configuration; they never grant permissions or replace runner evidence. See [iteration configuration and CLI](ITERATION.md).

## Persistent service extension

`domain/service.ts` defines service policy and durable record contracts. `adapters/github/webhook-server.ts` validates signatures and appends sanitized wake-up hints through `ServiceStore`; no execution runs in the receiver. `application/service.ts` coalesces deliveries, refreshes API evidence, dispatches candidate/owned-PR/ordinary-PR work and reconciles polling. Atomic event files permit ingress while the controller owns the execution lock. Receipts retain retry and interruption state; new deliveries during an active batch are acknowledged separately.

`ServiceBudget` serializes durable call/token reservations shared by every concrete Codex role and execution fork. A missing usage acknowledgement keeps the reserved charge after a crash. Service policy pauses propagate through pipeline/goal recovery without granting another goal budget. Operator requests and approval hints remain writable while the service runs. The progress outbox tracks desired/delivered comment digests; GitHub author-and-marker checks reconcile ambiguous creation results. See [service configuration and operation](SERVICE.md).

## Optional decision layer

`domain/decision.ts` defines decision configuration, typed output and durable records; `decision-policy.ts` owns the fixed questions and restrictive threshold logic. `ports/decision.ts` separates provider calls, evaluation and storage. The Jev HTTP adapter validates TypeSafe's wire contract and never sees GitHub credentials. The application evaluator serializes durable reservations and caches pinned-input results; atomic files retain uncertain attempts after interruption. Candidate intake rechecks live authorization before and after evaluation. A gate may defer new work but cannot grant execution, change intent or replace test evidence. Decision settings do not change execution identity or replenish goal budgets. See [Jev decisions](JEV-DECISIONS.md).

`decision-governance.ts` contracts define immutable human labels, fixed suites, evaluations, admission/outcome observations and operator requests. Application workflows recompute thresholds offline, compare identical datasets, preview evaluated policy changes and append atomic transition history. The worker processes requests at task boundaries, with idempotent evidence identities and compare-before-apply checks. Local console adapters depend on a `DashboardReader`; its application projection exposes bounded metadata only. See [decision governance](DECISION-GOVERNANCE.md).
