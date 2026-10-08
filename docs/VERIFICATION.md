# Verification

This revision is validated locally on Windows / Node.js 21.1.0 with strict TypeScript checking (including tests), 203 offline regression tests and compilation. Release builds also check native portable launchers and version consistency on each target platform.

Coverage includes:

- Signed Webhook ingress over synthetic localhost HTTP, durable delivery acknowledgement, atomic deduplication, queue capacity, coalescing and interrupted-receipt recovery.
- UTC daily service reservations across parallel roles and execution forks, midnight settlement, unknown/over-limit usage, operator pause/resume and independent failure circuits.
- Live-input revalidation for queued approval, polling compensation, events arriving during execution, completed-publication recovery and neutral handling of cached findings or stale approval.
- Author-and-marker progress-comment reconciliation after ambiguous writes, bounded outbox retries and feedback isolation.

- Goal acceptance coverage and dependency plans, bounded feature implementation, completed-step checkpoints, cross-round duplicate patches, replanning limits keyed by acceptance ID, persistent pause and publication recovery.
- Goal model/time accounting, unknown usage reservations, known over-budget consumption, same-commit experience isolation and candidate/baseline preview health gates.
- Authorized Issue intake, conservative PR base integration, trusted reviewer/CI feedback, frozen tests, non-force updates, full-tree interrupted-publication reconciliation and deduplicated improvement proposals.
- Goal CLI inspection/pause under the controller lock, polling cancellation and validation of command/configuration boundaries.

- Issue reproduction/repair, requirement quotes, unstable failures, Issue/target freshness, draft PR targeting/linking, replay identity and publish opt-in.
- pytest/JUnit XML and Go JSON parsing, source mapping, malformed/contradictory reports, missing events, entity rejection and generated Python/Go/Java tests.

- Controller ownership, stale/unknown/foreign locks, concurrent acquisition, recovery preview invalidation, exact Docker ownership rechecks, partial failures and interrupted-evidence retention.

- Failure categorization, bounded phase retries, cancellation, retained attempt evidence, unstable versus inconclusive repetition, and stopping source repair after environment failures.

- Mock Docker multi-command aggregation, working directories, stable legacy identities, service readiness/budgets, isolated resource naming, partial startup failure, cancellation and cleanup failure gates.

- Layer dependency/cycle enforcement, stable version-three task IDs, and clean-build CLI/Codex/reporter path resolution.

- Trusted policy, nested instructions, AST calls versus comments/strings, contradictory rules and exception expiration.
- Historical occurrence matching, scoped verbatim citations and protected-path rejection.
- Proactive plans, frozen tests, discovery checks, same-case red/green checks and changing failure fingerprints.
- New-behavior requirement citations, the base/head outcome matrix, mixed feature/regression repairs, ambiguous failures and generated-test side effects.
- Zero/skipped/duplicate/outside-root/contradictory reports and Vitest JSON fixtures.
- Real Node test-runner events from a small synthetic local fixture: nested suites, assertions, skips and module-load failures.
- Cancellation of a synthetic child process, freshness monitor and bounded retry timing.
- Task list/show/cancel/resume/rerun CLI on a synthetic repository, cancellation under the controller lock, persistent cancellation, replay identity/budgets and in-flight publication abort.
- Description changes, persistent task execution limits, controller lock and deduplication.
- Mock GitHub stale/draft/fork protection and executable-mode publication.
- Synthetic local Git snapshot and CLI comparison without modifying a real source checkout.

Commands:

```sh
npm run check
npm test
npm run build
```

No real Docker container, Codex inference, or GitHub repair PR is invoked by these tests. The user's requested scope is code completeness and offline verification; live integration acceptance remains separate. See GitHub Actions for commit-specific CI results.
