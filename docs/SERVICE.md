# Persistent iteration service

Version 1.6.0 adds `serve`: one local controller that accepts GitHub event hints, reconciles missed changes by polling, and runs the existing candidate and PR workflows. It uses the same trusted configuration, pinned evidence, independent tests and optional draft-PR publication gates as the CLI. Portable users can replace `node dist/cli.js` below with `./repopilot` on Linux/macOS or `.\repopilot.cmd` on Windows.

## Configuration and startup

Configure `iteration.queue` for Issue intake, `iteration.maintenance` / `iteration.postMerge` for owned PR follow-up, or explicitly enable `service.reviewPullRequests` for ordinary same-repository PR review. Issue intake still requires the structured runner, `agent.enabled`, `agent.repair`, trusted authors, required labels and allowed paths. `autoApprove` stays false by default. See [candidate iteration](CANDIDATE-ITERATION.md) and [iteration configuration](ITERATION.md).

Add this optional section to the trusted controller configuration:

```json
{
  "service": {
    "reviewPullRequests": false,
    "progress": false,
    "queue": {
      "maxBatch": 20,
      "maxPending": 1000,
      "maxAttempts": 3,
      "retentionDays": 14
    },
    "limits": {
      "dailyCalls": 200,
      "dailyTokens": 2000000,
      "dailyTasks": 20,
      "failureThreshold": 3
    },
    "webhook": {
      "host": "127.0.0.1",
      "port": 8787,
      "path": "/github/webhook",
      "secretEnv": "REPOPILOT_WEBHOOK_SECRET",
      "maxBodyBytes": 1000000
    }
  }
}
```

The [service example](../examples/service.json) provides a full configuration with Agent repair and publishing disabled. Select a prepared test image and enable the desired capabilities before processing executable work.

```sh
npm run build
node dist/cli.js serve --config config.local.json
node dist/cli.js serve --config config.local.json --once
```

Omit `webhook` to use polling only. `serve --once` performs one bounded queue batch with polling reconciliation and does not start an HTTP listener. The controller emits JSON results and retains work that exceeds `maxBatch` for subsequent batches. `pollSeconds` determines the reconciliation interval; incoming events are checked between tasks. Task execution is serialized, while an individual goal may use its configured bounded DAG parallelism. Use a process supervisor appropriate to your operating system to restart the controller. SIGINT / SIGTERM interrupt active work and close the listener.

## GitHub Webhook

Set the environment variable named by `secretEnv` to a random secret of at least 32 characters. The controller does not write that secret to event files or pass it to Agent/test containers. Put an HTTPS reverse proxy or tunnel in front of the local listener and configure GitHub's payload URL to that reachable HTTPS endpoint. Keep the raw request body unchanged. Direct polling requires no public ingress.

Use JSON payloads. Supported hints include Issue changes/comments, PR changes/reviews, check-run/check-suite completion, commit statuses, push and workflow completion. Unsupported actions and RepoPilot progress-comment events are ignored. Checks and push trigger repository reconciliation rather than treating CI output as a repair instruction.

The receiver verifies `X-Hub-Signature-256` against the original bytes with HMAC-SHA256 and constant-time comparison, validates the repository, and enforces body size and request time limits. It returns 202 only after the delivery has been persisted, including duplicate acknowledgements. A storage/capacity failure returns 503 so the delivery can be retried. A bad signature returns 403. See [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [delivery best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

Events retain delivery identity, a payload digest, event type and object number; payload prose is not stored or executed. Repeated delivery IDs with identical evidence deduplicate during retention. Pending events for the same Issue or PR are coalesced. The worker reads the current Issue/PR, labels, author and commit via the API, so arrival order cannot restore stale authorization. Events arriving during execution remain pending for the next batch. Polling also discovers eligible Issues and tracks configured owned PRs, compensating for missing Webhooks.

## Daily budget and circuit

The ledger lives under `dataDir/service`, scoped to the configured repository. Daily periods use **UTC** (08:00 in Asia/Shanghai). Restarts, event retries and `service resume` preserve consumed allowances. The existing goal/candidate retry and time limits still apply independently.

Each Codex container invocation, including role agents and parallel execution forks, reserves one call and `agent.maxTokens` in the persistent daily ledger before starting. A valid response replaces that token reservation with reported actual usage. A crash or response without valid usage retains the reservation; known usage above the reservation is recorded in full. New calls stop when the remaining allowance cannot fit the next reservation. A single call can exceed its reserved token count; the ledger blocks subsequent calls but does not provide a billing or currency hard cap.

`dailyTasks` counts admitted reproduction/execution attempts, including recovery attempts. Coalesced hints, already completed evidence, waiting-for-approval Issues, routine polling and waiting-for-CI checks do not spend task admission merely for being inspected. An admitted task may finish within the remaining model allowance after it occupies the last task slot. When a service limit blocks an in-flight pipeline, the candidate remains recoverable without spending its candidate failure allowance. Its bounded report/goal execution counters remain intact.

Consecutive execution/environment errors or failed independent verification open the circuit at `failureThreshold`. Successful reproduction/verification resets the consecutive count. Stale approval, oversized feedback, already-satisfied behavior and repeated cached findings are not counted as fresh execution failures. A post-merge regression transition counts once. Progress-comment delivery failures use a separate retry allowance. Inspect local evidence before `service resume`; resume clears the operator pause and circuit, and permits one new retry window for pending feedback. It does not reset daily usage or goal budgets.

Service transport, budget and progress settings are excluded from verification configuration identity. Adjusting them does not invalidate prior pinned reports or replenish a goal's execution budget. Changes to execution policy, runner or Agent settings still invalidate their configuration identity.

## Operation and human approval

These commands work while the service holds the controller lock:

```sh
node dist/cli.js service status --config config.local.json
node dist/cli.js service pause --config config.local.json
node dist/cli.js service resume --config config.local.json
node dist/cli.js candidates list --config config.local.json
node dist/cli.js candidates show CANDIDATE_ID --config config.local.json
node dist/cli.js service approve CANDIDATE_ID --expected EVIDENCE_DIGEST --config config.local.json
node dist/cli.js events list --status dead --config config.local.json
node dist/cli.js events retry EVENT_ID --config config.local.json
```

Pause/resume and approval commands persist requests; their acceptance is not a claim of completed execution. Pause interrupts active service work as well as blocking future calls. Approval carries the exact inspected candidate digest, then the worker refreshes and rechecks evidence before applying it. Changing the Issue or revoking labels invalidates a queued approval. Use `service approve` with a running service; the standalone `candidates approve` / `run` commands require the exclusive controller lock.

Unexpected event failures retain an exponential retry time and become `dead` at `maxAttempts`. Explicit `events retry` creates a linked wake-up attempt; it cannot replenish candidate/goal budgets or make blocked evidence executable. A processing receipt left by a crash can resume under the next controller, using the existing candidate/goal/report identities. Already-published work is reconciled before new publication.

Completed delivery records older than `retentionDays` are pruned. Pending, processing and dead events, verification reports, goals and budget evidence remain available. Deduplication outside the retained delivery window relies on the candidate/goal/publication identities and fresh API reads. The JSON ledger retains the most recent 14 UTC days. Keep the local data directory private and backed up.

## GitHub progress feedback

Set `service.progress=true` to enable Issue/PR comments independently from repair publication. It requires a GitHub user token with comment write permission; `publish` remains the separate switch for repair branches and draft PRs. See [GitHub comment permissions](https://docs.github.com/en/rest/issues/comments).

One marker identifies a progress comment per GitHub object. The controller updates a comment only when its marker and authenticated author match. If a creation response is lost, the next attempt finds the saved remote comment before writing. Spoofed markers by other authors are not edited. The local outbox retains the desired digest, delivered digest, retry state and remote comment ID. Feedback covers queued/reproducing, awaiting approval, running, completed and blocked states, with report/goal IDs, pinned commit and a repair-PR link when available. Full logs and repository text remain local.

Progress comments are filtered out of repair-review feedback and ignored as wake-up events. They do not become new acceptance criteria or grant execution permission. Failed deliveries stop automatic retry after `queue.maxAttempts`; changed status or an explicit `service resume` opens a fresh retry window.

## Optional Jev decisions and operator requests (1.8.0)

The [Jev decision layer](JEV-DECISIONS.md) can inspect trusted Issue requests before new automatic intake. Its independent UTC daily ledger accounts for TypeSafe requests; `service.limits` continues to account for Codex. Gate deferral is a neutral service outcome, so uncertainty does not trip the verification circuit or spend a task admission. A service pause also interrupts an active Jev request. See `decisions status|list|show` for inspection while the service holds its lock. The 1.8.0 [governance workflow](DECISION-GOVERNANCE.md) queues manual labels, bounded decision retries and previewed policy changes while the service runs; requests apply at controller boundaries without resetting budgets. The separate read-only `dashboard` can run alongside the service.
