# Issue reproduction and repair

Available since 1.1.0 through `fix --issue`. For the current release, use the matching 1.6.0 controller and Agent image.

```sh
npm run dev -- fix --issue 123 --config config.local.json
npm run dev -- fix --issue 123 --branch release/next --config config.local.json
```

The repository comes from the trusted config. The target is the default branch unless `--branch` selects another branch. `fix` fetches its exact commit into the controller's Git cache and records the open Issue's title/body. It does not modify your checkout or read Issue comments/attachments. PR numbers and closed Issues are rejected.

Enable `agent.enabled`, `agent.repair` and a structured runner. Configure test images/dependencies first. `publish=false` keeps the report and verified proposal local; `publish=true` permits a separate branch and draft PR. This workflow is operator-triggered, without Issue polling, comment commands or automatic merging.

## Evidence gates

1. Existing tests on the pinned target must pass.
2. Codex proposes NEW regression tests. Every scenario must quote at least eight characters verbatim from the Issue description. A `new_behavior` label cannot exempt a reproduction failure.
3. Generated tests must be discovered, execute without skips and reproduce stable failures on the same target. Original tests must remain passing with their identities preserved.
4. Reproduction is repeated before proposing a production-code patch. Missing cases, environmental problems and unstable fingerprints block repair.
5. Tests, policy, configuration and manifests are frozen. The repaired snapshot must pass original/generated cases and policy review.
6. The Issue must remain open with the same title/body, and the target branch must still point to the recorded SHA. Checks run during execution and publication.

The output branch is `autofix/issue-N/TASK_ID`. Its draft PR targets the selected branch and includes evidence plus `Fixes #N`. GitHub may close the Issue when that PR is merged; RepoPilot does not close it itself. Branch collisions and interrupted publication use the same parent/tree checks as PR-driven repair.

An unreproduced defect retains investigation/test evidence without publication. Maintainers should review the generated test as well as the proposed repair.

## Replay and limits

Existing `tasks show`, `cancel`, `resume` and `rerun` commands apply. Issue number, description, branch and SHA are retained in replay metadata and task identity. Replay checks live inputs; run `fix` again for updated inputs. Budgets, execution limits, cancellation and environment retries remain enforced.

Issue analysis can need broader context than a PR diff. Context batching and limits remain in effect; oversized files or exhausted budgets produce a report rather than bypassing verification. Public text-based repositories remain the supported scope.
