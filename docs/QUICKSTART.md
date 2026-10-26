# RepoPilot 1.8.0 portable release

Download the archive for your OS/CPU from https://github.com/indada/repopilot/releases/tag/v1.8.0 and extract it. Linux and macOS packages support x64 and ARM64; Windows supports x64. Verify the archive against the release's SHA256SUMS.txt. Keep the entire extracted directory together: the launcher uses the included Node.js runtime and dependencies. No Node.js installation or npm command is required.

Install Git and Docker with Linux containers. Use a dedicated worker for untrusted code. These packages are CLI tools, not graphical installers; macOS packages are not notarized and Windows launchers are not code-signed. Linux requires a glibc-based distribution supported by Node.js 22.

On Linux/macOS, run from the extracted directory:

```sh
./repopilot --version
./repopilot init --repo OWNER/REPOSITORY --config config.local.json
docker pull node:22-bookworm-slim
./repopilot doctor --config config.local.json
./repopilot check --config config.local.json --repo /path/to/project --base main --head feature
```

On Windows PowerShell, replace `./repopilot` with `.\repopilot.cmd` and use a Windows repository path. You can also invoke `runtime\node.exe dist\cli.js --help` directly. The archive contains a native Node executable plus the application, not a single-file application executable.

`init` will not overwrite an existing configuration. Edit its test image, commands and repository before use. `doctor` checks local prerequisites and reports credential presence without printing secrets; it does not authenticate credentials, run tests or make model calls.

## Enable Codex

The versioned agent image is `ghcr.io/indada/repopilot-agent:1.8.0` (Linux amd64/arm64). Pull it before enabling the agent:

```sh
docker pull ghcr.io/indada/repopilot-agent:1.8.0
```

Alternatively, build from the source files included in the extracted directory:

```sh
docker build -f Dockerfile.agent -t ghcr.io/indada/repopilot-agent:1.8.0 .
```

Set `OPENAI_API_KEY` in your shell environment using your credential manager. Set `agent.enabled=true` for review and test planning, and `agent.repair=true` for repair proposals. The initialized config selects the matching 1.8.0 image. Model calls send selected repository context to OpenAI services.

To watch GitHub PRs, set `GITHUB_TOKEN` or `GH_TOKEN`, then run `repopilot watch --config config.local.json --once`. Publishing additionally requires `publish=true` and repository Contents/Pull requests write permissions. Review results locally before enabling publication. All three switches are disabled initially.

Reports are written under `.repopilot-data` relative to your current directory. Run `repopilot tasks list --config config.local.json` to inspect them. See the bundled README and docs for verification gates, service environments, cancellation and recovery.

## Issue repair and recovery

After configuring the runner and enabling agent review/repair:

```sh
./repopilot fix --issue 123 --config config.local.json
./repopilot recover --config config.local.json
```

`fix` uses the repository default branch unless `--branch` is supplied. Publishing remains opt-in. See [Issue repair](https://github.com/indada/repopilot/blob/v1.8.0/docs/ISSUE-REPAIR.md) for reproduction gates and [multilingual tests](https://github.com/indada/repopilot/blob/v1.8.0/docs/MULTILINGUAL-TESTS.md) for pytest, Go and JUnit configuration. Recovery first returns a preview; follow [recovery](https://github.com/indada/repopilot/blob/v1.8.0/docs/RECOVERY.md) to apply with its expected token.

## Goal-driven iteration

Add the optional `iteration` configuration described in the bundled `docs/ITERATION.md`, enable agent review/repair, and adapt `examples/goal.json` to your acceptance criteria and allowed paths:

```sh
./repopilot goals plan --spec examples/goal.json --config config.local.json
./repopilot goals run GOAL_ID --config config.local.json
./repopilot iterate --once --config config.local.json
```

Replace `GOAL_ID` with the planning result. `iterate` requires an explicitly configured Issue queue or PR maintenance policy. Publication remains opt-in. Goal budgets, pause/resume, review follow-up and isolated preview verification are explained in the iteration guide.

To isolate planning, testing, implementation and review in separate Codex roles, add `iteration.collaboration` as described in `docs/MULTI-AGENT-COLLABORATION.md`. The roles share one bounded execution budget. Inspect persisted DAG state and role handoffs with:

```sh
./repopilot goals graph GOAL_ID --config config.local.json
```

Post-merge tracking and repeatable Agent evaluations are documented in `docs/POST-MERGE-EVALUATION.md`.

## Persistent iteration service

Version 1.8.0 includes `serve`. Adapt `examples/service.json` with your repository, trusted Issue authors, labels, allowed paths, prepared test image and the matching 1.8.0 Agent image. Enable Agent review/repair after setting credentials. Polling works without a public Webhook endpoint; publication, progress comments and automatic approval are separate opt-ins.

```sh
./repopilot serve --config config.local.json
./repopilot service status --config config.local.json
./repopilot candidates list --config config.local.json
./repopilot candidates show CANDIDATE_ID --config config.local.json
./repopilot service approve CANDIDATE_ID --expected EVIDENCE_DIGEST --config config.local.json
./repopilot service pause --config config.local.json
./repopilot service resume --config config.local.json
```

Run inspection and approval commands in another shell while the service runs. Use the exact candidate digest shown by inspection. The Issue queue now reproduces behavior before approval; an existing 1.5.0 queue configuration waits for manual approval unless `iteration.queue.autoApprove=true` is explicitly configured. See `docs/SERVICE.md` for signed Webhooks, UTC daily budgets, event retries and progress feedback, and `docs/CANDIDATE-ITERATION.md` for the candidate state machine.

## Upgrade from an earlier release

Version 1.8.0 adds optional Jev decisions and [decision governance](https://github.com/indada/repopilot/blob/v1.8.0/docs/DECISION-GOVERNANCE.md). Adapt `examples/jev-service.json` to enable them deliberately. `decisions review` and queued retries/policy changes can be submitted while the service runs. Start the local read-only console in a second terminal with `./repopilot dashboard --config config.local.json`, then open the complete local URL printed by the command.

Stop the old controller and extract 1.8.0 into a separate directory. Preserve your configuration and data directory; run from the same working directory or keep the configured data path unchanged. Update `agent.image` to `ghcr.io/indada/repopilot-agent:1.8.0` and pull it. Existing configuration is not overwritten by `init`. Run `--version` and `doctor` before restarting.

Configuration changes may require `tasks rerun` rather than `tasks resume`; rerun preserves the original pinned commits. Use `watch` or a new `fix` for current GitHub inputs. Keep old reports and snapshots. Version 1.0.0 locks and unlabeled Docker resources require manual inspection; 1.8.0 recovery does not claim ownership of them.
