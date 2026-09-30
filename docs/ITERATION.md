# Goal-driven iteration (1.5.0)

These commands are included in the 1.5.0 portable packages. Use the matching `ghcr.io/indada/repopilot-agent:1.5.0` image, or build both the controller and Agent from the same checkout. Existing `check`, `watch` and `fix` workflows remain available without iteration configuration. The examples below use a source installation; portable users replace `npm run dev --` with `./repopilot` on Linux/macOS or `.\repopilot.cmd` on Windows.

## Define and execute a goal

Start from [examples/goal.json](../examples/goal.json). A goal declares an objective, `feature` or `bugfix` mode, acceptance criteria with unique IDs, an optional branch/Issue, and allowed repository paths. Paths are exact files or directory prefixes, not glob patterns; include the test paths as well as production paths. An omitted branch uses the repository default. An attached Issue must remain open and unchanged.

```sh
npm run dev -- goals plan --spec examples/goal.json --config config.local.json
npm run dev -- goals show GOAL_ID --config config.local.json
npm run dev -- goals run GOAL_ID --config config.local.json
npm run dev -- goals pause GOAL_ID --config config.local.json
npm run dev -- goals replan GOAL_ID --config config.local.json
npm run dev -- goals list --status needs_attention --limit 20 --offset 0 --config config.local.json
```

Planning calls Codex and persists a dependency-ordered plan; it does not publish code. Every acceptance criterion must belong to exactly one step. `run` executes or resumes the saved goal. `replan` asks Codex to revise the remaining plan and then executes it; already completed steps cannot be rewritten. `pause` records a request that an active controller observes; an idle goal keeps its last status until execution observes that request. `run` explicitly clears a pause request. Inspection and pause remain available while execution holds the controller lock.

Each step generates and freezes acceptance tests before changing production code. Feature mode implements missing behavior; if independently executed acceptance tests already pass, it can retain the new tests without an unnecessary production-code change. Bugfix mode requires reproducible failure before repair. Independent runner results determine acceptance. Final cumulative tests must retain the original and completed-step cases. Protected policy, test infrastructure and dependency manifests stay protected even if included in allowed paths. Incomplete evidence, stale inputs, repeated unsuccessful repairs or exhausted budgets stop work for inspection. No command merges a PR.

Goals keep their plan, changes, report references, usage and elapsed time under the configured data directory. Interrupted operations and calls without complete usage data retain token reservations; known usage above a reservation is charged in full. After an unclean exit, elapsed downtime counts toward the goal deadline. Configuration changes invalidate execution of old goals: inspect their evidence and create a new goal with the new configuration. `show`, `list` and `experiences` can still inspect historical state. Running an already published goal only restores publication state and clears its pause request, allowing maintenance to resume.

## Configure limits and opt-in automation

Add the following `iteration` section to a trusted controller configuration with `agent.enabled=true`, `agent.repair=true` and a structured test runner. Choose allowances that cover the configured per-execution `agent.maxCalls` and `agent.maxTokens`; the controller reserves these before each model execution. Keep `publish=false` until you want verified GitHub branches and draft PRs.

```json
{
  "iteration": {
    "maxSteps": 8,
    "maxRounds": 3,
    "maxCalls": 80,
    "maxTokens": 1000000,
    "timeoutSeconds": 7200,
    "queue": {
      "labels": ["repopilot-ready"],
      "trustedAuthors": ["YOUR_GITHUB_LOGIN"],
      "allowedPaths": ["src", "tests"],
      "featureLabel": "enhancement",
      "priorityLabels": ["priority:high", "priority:normal"],
      "maxPerRun": 1,
      "autoApprove": false,
      "maxFailures": 3
    },
    "maintenance": {
      "trustedReviewers": ["YOUR_GITHUB_LOGIN"],
      "requiredChecks": ["test"]
    },
    "postMerge": {
      "requiredChecks": ["test"],
      "requireIssueClosed": true
    }
  }
}
```

The JSON above is a configuration fragment, not a complete configuration. Queue, maintenance and post-merge tracking are optional and disabled when absent. `maxRounds` bounds attempts per acceptance criterion, including after replanning; model and elapsed-time budgets cover the whole goal. One controller owns the data directory and serializes state and publication writes. The development branch after v1.5.0 can execute independent ready DAG nodes concurrently when `iteration.collaboration.maxParallel` is explicitly greater than 1; see [multi-Agent collaboration](MULTI-AGENT-COLLABORATION.md).

```sh
npm run dev -- iterate --once --config config.local.json
npm run dev -- iterate --config config.local.json
npm run dev -- goals maintain GOAL_ID --config config.local.json
npm run dev -- goals track GOAL_ID --config config.local.json
```

In the development line after 1.5.0, `iterate` polls open Issues through the [evidence-driven candidate queue](CANDIDATE-ITERATION.md). It requires all configured labels and a trusted **Issue author**, ranks candidates by priority label, and uses the complete Issue title/body as the acceptance request. Maintainers should supply precise, independently testable Issue descriptions. The configured `featureLabel` selects feature mode; other eligible Issues use bugfix mode. Each candidate must first demonstrate missing behavior on a pinned commit with stable independent test evidence. The default `autoApprove=false` stops there for manual approval. Explicit `autoApprove=true` allows eligible candidates to continue to a bounded goal and optional draft PR. Existing queue configurations therefore no longer execute Issues directly after an upgrade. An Issue that already owns a goal is never automatically restarted when edited, preventing its budget from being replenished. Ctrl+C stops polling and requests cancellation of active execution. This queue does not choose a product roadmap.

Automatic intake accepts complete Issue requests of 8–2000 characters and titles of 8–200 characters; larger requests need an explicit goal with separate acceptance criteria. Review maintenance accepts at most 20 applicable comments of up to 2000 characters each. Oversized requests become blocked candidates instead of silently truncating requirements.

When `maintenance` is configured, each polling cycle also processes published goals serially in rotating batches, up to `queue.maxPerRun` (one without a queue). Paused goals are skipped. Individual maintenance errors are reported and stop automatic follow-up for that goal for the current polling session. Retries share the existing goal budget and retain failed patch fingerprints. You can configure maintenance without an Issue queue. `goals maintain` runs the same follow-up explicitly for a selected goal.

`maintain` examines the goal's owned, open PR, configured CI check names and feedback from trusted reviewers. Pending or missing required checks leave it waiting. Applicable feedback, reproducible failures and compatible base changes can produce a verified update to the existing branch. Base integration uses conservative file-level three-way comparison; overlapping edits, deletions and mode changes require human review. Stale inputs stop the update. Failed follow-ups can retry within the remaining goal budget; repeated failed patches are blocked. A remotely completed update can be reconciled after interruption only when its commit marker, parents and full tree match saved verification evidence. The controller never force-pushes or merges the PR, and arbitrary comments do not grant new permissions.

## Experience and improvement proposals

```sh
npm run dev -- experiences --limit 20 --config config.local.json
npm run dev -- discover --config config.local.json
npm run dev -- discover --apply --expected PREVIEW_TOKEN --config config.local.json
```

Experience entries retain outcomes, report references and recent notes. Planning reuses a small set only when repository, pinned commit and configuration match. They are context, never verification evidence or new permissions.

Discovery derives proposals from local error findings and failed or incomplete baseline evidence. It does not scan arbitrary new repositories or invent independent product requirements. Preview produces a content token; `--apply --expected` requires that exact current preview and `publish=true`, then opens deduplicated GitHub Issues for maintainer review. New proposals receive no automatic queue authorization label. Selecting an eligible Issue remains a separate maintainer decision.

Post-merge regressions also enter discovery as evidence-based proposals. See [post-merge tracking and Agent evaluation](POST-MERGE-EVALUATION.md) for the state model, merge-commit checks and evaluation identity fields.

## Isolated preview and rollback rehearsal

Optionally configure `iteration.preview` using the same schema as `runner`, with a separately prepared image and health-test commands. For example:

```json
{
  "iteration": {
    "preview": {
      "image": "my-project-health-tests:local",
      "command": ["node", "--test", "tests/health.test.js"],
      "reporter": "node",
      "timeoutSeconds": 300,
      "memory": "1g",
      "cpus": 2
    }
  }
}
```

The controller runs candidate health checks and a baseline rollback rehearsal in disposable Docker environments before publishing. Prepare required dependencies and services in the trusted configuration. This verifies that both snapshots can satisfy the health suite in isolation. It does **not** deploy a real staging/production environment, switch live traffic, migrate production data, or prove production rollback safety. Release and production deployment remain external decisions.
