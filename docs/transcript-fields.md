# What Claude Code records, and what it does not

Inspected read-only on Claude Code 2.1.331 against ~4 400 subagent files and ~390 sessions in three profiles (versions 2.1.68 to 2.1.331 are mixed in the history). "unknown" is shown in the UI wherever a row below says *not recorded*.

| Question | Field (where) | Reliable? |
|---|---|---|
| Session | `<profile>/projects/<slug>/<sessionId>.jsonl`; key used here is `profile:sessionId` | yes, no duplicates across profiles in this history |
| Project | `cwd` on records, resolved to the git common dir. `slug` = `cwd` with every non-alphanumeric as `-` | yes; the folder name equals the slug of a recorded cwd for 387/391 files |
| Resume folder | the recorded cwd whose slug equals the transcript's folder | 272/274 sessions; sessions that moved into a worktree later keep their launch folder |
| Worktree | `worktree-state` record (`worktreePath`, `worktreeBranch`), `relocated.relocatedCwd`, `cwd` under `.claude/worktrees/`, subagent `meta.worktreePath` | yes when present; removed worktrees stay recorded but cannot be resumed |
| Title | `ai-title` (194/274), else first prompt | not always: "Untitled session" when neither exists |
| Where I left off | `system/away_summary` (Claude Code's own recap, 95/274), else last answer, else last prompt | recap only exists for some sessions |
| Running now | `<profile>/sessions/<pid>.json` + pid alive + `procStart` matches `/proc/<pid>/stat` | yes. A recent mtime is **not** used |
| Unfinished | last record kind (prompt / tool_use / tool_result = stopped mid-turn), pending `AskUserQuestion`, question in last answer (wording guess), `jobs/<id>/state.json` (9 sessions) | "waiting on you" from wording is a heuristic and labelled so |
| Model per message | `assistant.message.model` | yes: gives real change points (14 sessions changed model) |
| Agent calls | assistant `tool_use` named `Agent`/`Task` (what actually ran). The `agent_listing_delta` attachment only lists what is *available* and is ignored | yes |
| Parent/child | `subagents/agent-<id>.meta.json` `toolUseId` == parent `tool_use.id` (2 735 of 2 777 calls linked), `parentAgentId` for nesting (28), `spawnDepth` | mostly; 42 calls have no transcript, 4 transcripts have no parent call: both shown as such |
| Agent model | `toolUseResult.resolvedModel` (async launches), else last message of the agent transcript, else `meta.model` (may be an alias such as `sonnet`) | model changes *inside* an agent are not scanned |
| Agent outcome | completion `<task-notification>` in the parent, `meta.finished`, `meta.stoppedByUser` | absent for many: shown as "outcome unclear" |
| Workflow run | `workflows/wf_*.json` (name, status, agentCount, phases, per-agent model, summary, result); agents in `subagents/workflows/<runId>/` | `status: completed` can coexist with a result saying the build stopped: both are shown |
| Decisions | `AskUserQuestion` tool_use + its `toolUseResult.answers` | yes |
| Outputs | `Write`/`Edit` file paths, `pr-link`, `frame-link` (artifacts) | files written by Bash (redirects, scripts) are not seen |
| Timestamps | `timestamp` on conversation records | yes; last activity uses conversation records only |
| Scheduled tasks | `system/scheduled_task_fire` (past fires only) | the *future* schedule of an in-session cron is not in the transcript |

## Not recorded: smallest way to capture it for future runs

1. **Which saved workflow a Claude Code `Workflow` script belongs to / how to rerun it.** The run file stores the script path and result, not the inputs the owner chose. Capture: save it as a dashboard workflow (Save as workflow), whose runs record resolved inputs and outputs; or have scripts write their inputs into `result`.
2. **Upcoming in-session cron / `/loop` wakeups.** Only fires are logged. Capture: create recurring work as a dashboard workflow (the scheduler lists upcoming runs).
3. **Agent outcome and model switches inside an agent.** Capture: nothing to add, but scanning every agent transcript fully (not done, cost) would give it.
4. **Files changed through Bash.** Capture: a `PostToolUse` hook that appends `git status --porcelain` paths to the session folder.
5. **Which session a fresh handoff session came from.** Solved here: the handoff text carries `Handoff ID: h_xxxxxxxx`, stored in `data/handoffs/<id>.json`, and the indexer reads it from the new session's first prompt (`handoffId`).
