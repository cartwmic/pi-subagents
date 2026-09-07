# Headless compaction regression

Run from the repository root with Python 3 and a real Pi CLI:

```sh
python3 test/blackbox/headless-compaction.py \
  --mode background --scenario inter-turn \
  --artifacts /tmp/subagent-compaction-background
```

Each artifact directory must be new and outside the repository. `--pi` selects
the CLI and `--extension` selects an auto-compact extension (defaults to the
installed CLI and `~/.pi/agent/extensions/auto-compact/index.ts`). The deployed
extension must be enabled and trigger at the fixture's roughly 45% context
usage. Its configuration is never rewritten. Pi must support draining
extension-owned compaction/continuation work in print mode; on tested Pi 0.85.1 this
requires the separate `headless-extension-drain` patch. Missing prerequisites
fail the proof rather than silently skipping it.

Run `inter-turn`, `final-turn`, `summary-error`, `resume-error`, `timeout`, and
`linger` with both `--mode foreground` and `--mode background`; additionally run `stop`
with background mode. Use a distinct `--artifacts` directory for each case.

This is not a replacement child CLI or a mocked subagent executor. A real
parent Pi loads this repository's extension and calls the public `subagent`
tool. The actual foreground executor or detached background runner launches
the real Pi CLI. A local OpenAI-compatible backend scripts both models, so no
live credentials or provider are needed. The child uses native read/write,
native summarization, and the enabled auto-compact extension. Discovery uses
isolated settings, not `--no-extensions`; the observer only records lifecycle
metadata and the child's exact launch argv.

The summary and continued assistant each take 2.5 seconds, exceeding the
unchanged one-second terminal drain. Timeout and stop interrupt a 12-second
summary. The proof requires saved native compaction, retained extension
continuation, a completed post-compaction write, exact `PROOF_DONE` child
result, the native final assistant, and terminal status/process receipts.
Final-turn compaction must not resume extra work. Summary failure must recover;
resumed provider failure, timeout, and stop must remain failures. Stop also
checks actual failure delivery after the host consumes its transient result.
`linger` leaves a fixture helper holding child stdout after Pi exits, requires
the real post-exit stdio guard to settle the public call, then reaps the helper.
The parent exiting successfully by itself is not proof of child success.

Captures include command argv, local HTTP requests, parent JSONL, native child
session/transcript, lifecycle observer events, status/results and a failing or
passing `receipt.json`. Keep them outside git. To demonstrate regression, run
the same fixture on the preceding source revision: inter-turn loses the
compaction, continuation, write and result; final-turn can return successful
text while silently losing compaction.

## Lifecycle correction

`agent_settled` settles a low-level run. Manual `ctx.compact()` aborts that run,
then emits `compaction_start`; its completion callback can start a new run.
Neither `agent_settled` nor an assistant `stop` means the print host has finished
its extension drain. Both supervisors now share state that suspends final drain
through compaction and cancels it on new agent/turn activity. Compaction ending
restores pending final cleanup so final-turn compaction and lingering children
still settle. Watchdog settlement cannot bypass that state.

No timer is lengthened or removed. Explicit run timeouts, abort/stop,
SIGTERM/SIGKILL escalation, protocol limits, watchdog tails, and post-exit stdio
guards remain in force. A compaction still actively awaiting a provider is
active work: use `timeoutMs` to bound it, just as for an ordinary model request.
Arbitrarily delayed extension callbacks without corresponding lifecycle events
are not a new supported protocol.

`npm run test:all` covers the normal baseline. The added unit and foreground/
background integration cases also exercise both settlement/compaction orders,
slow continuation, and final-turn lingering-process cleanup. Existing abort,
timeout, error, watchdog, protocol, and post-exit stdio tests remain applicable.
When running tests from inside a subagent, remove inherited `PI_SUBAGENT*` and
`PI_INTERCOM*` variables from the test subprocess environment; they describe the
caller, not the fixtures. Install development dependencies with
`npm ci --ignore-scripts` if this checkout was installed runtime-only by Pi.
