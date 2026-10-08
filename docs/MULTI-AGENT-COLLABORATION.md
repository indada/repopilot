# Multi-Agent collaboration

RepoPilot can assign planning, acceptance-test design, implementation and policy review to separate Codex roles while retaining a deterministic controller and independent runner as the authority for state transitions.

Role separation shipped in v1.5.0. Bounded parallel DAG execution described below is included in the v1.6.0 portable release.

## Enable role isolation

Add `collaboration` under `iteration`. Every role can inherit `agent.model` or override it independently:

```json
{
  "agent": {
    "enabled": true,
    "repair": true,
    "model": "DEFAULT_CODEX_MODEL"
  },
  "iteration": {
    "collaboration": {
      "maxParallel": 2,
      "resourceBudget": { "cpus": 8, "memoryMiB": 6144 },
      "roles": {
        "planner": { "model": "PLANNER_MODEL" },
        "tester": {},
        "developer": {},
        "reviewer": { "model": "REVIEWER_MODEL" }
      }
    }
  }
}
```

The roles have fixed capabilities:

| Role | Output used by the controller | Authority it does not have |
| --- | --- | --- |
| Planner | Dependency-ordered steps covering acceptance IDs | Cannot modify code or mark tests as passed |
| Tester | New frozen tests tied to exact acceptance text | Cannot repair production code |
| Developer | Production-file replacements within the goal scope | Cannot edit frozen tests or repository policy |
| Reviewer | Cited semantic findings against trusted base policy | Cannot approve a failed independent test run |

Each role uses a separate Codex thread and container. GitHub credentials remain in the controller. All roles share the configured per-execution call and token budget, so enabling four roles does not multiply the budget. Unknown usage after interruption remains reserved.

## Durable handoffs and task graph

Every role call records a bounded handoff containing role, action, input/output digests, status, summary and time. Invalid plans, repeated or invalid patches and reviewer vetoes are recorded as `rejected`; transport or schema failures are `failed`. These records describe orchestration and are not proof that code works.

Goal steps maintain explicit `pending`, `running`, `completed`, `rejected` and `blocked` states with attempt counts and report IDs. A rejected dependency blocks downstream steps while unrelated evidence remains available for inspection. The graph is recoverable from the goal state:

```sh
npm run dev -- goals graph GOAL_ID --config config.local.json
```

The controller decides which DAG node may run, verifies dependencies, applies scope rules and persists transitions. The independent runner can veto every candidate. Reviewer and Tester output cannot bypass that veto, and the Coordinator never merges or deploys a PR.

## Bounded parallel execution

Set `iteration.collaboration.maxParallel` to 2–4 to execute independent ready nodes concurrently; the default is 1. The optional `resourceBudget` can reduce the selected wave size. Each node conservatively reserves two CPUs and 2048 MiB for its Codex container plus the configured runner and all test services. If the budget cannot fit one node, execution stops with a configuration error. This is a scheduler admission limit; it does not measure or enforce total host usage outside RepoPilot.

The controller selects currently ready DAG nodes in plan order and reserves a full per-execution Agent budget for each node before starting the wave. Each node receives a separate Agent instance and the same immutable input snapshot. Its tests and repair stay in disposable, isolated execution environments.

Only branches with durable, passing individual evidence are eligible for acceptance. The controller rejects changes outside the goal scope, protected paths and snapshots that violate trusted static policy. In plan order, it assigns each changed path to its first verified owner. Later branches touching an owned path are discarded and run again, serially, against the updated snapshot with a fresh budget reservation. This applies even when the two proposed file contents are identical. Nonconflicting branches are merged and tested together; the independent runner must preserve original and accepted-branch test identities before any result enters the goal state.

If one branch fails independently, passing siblings may still be retained after cumulative verification. A terminal failure stops the goal before publication; a stable test failure or retryable transport error may be replayed within the existing per-criterion, model and time limits. A failed cumulative merge accepts none of its branches. Final verification still requires every goal step and its tests to pass before a draft PR can be proposed.

The saved batch pins its input digest, report references and budget settlement. After an interruption, complete terminal reports can be reused for merge verification without another Agent call. Missing or unfinished reports fail closed; explicitly replan to request new bounded executions. `goals graph` shows the active batch, serial replay queue, node states and a bounded wave audit containing report IDs, path owners, conflicts and decisions.
