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

Run `inter-turn`, `final-turn`, `summary-error`, `resume-error`, `timeout`,
`linger`, `delayed-start`, `timeout-start`, and `shutdown-linger` with both
`--mode foreground` and `--mode background`; additionally run `stop` and
`stop-start` with background mode. Run `summary-error` and `resume-error` again
with `--start-delay-ms 2500` in both modes. Use a distinct `--artifacts`
directory for each case.

This is not a replacement child CLI or a mocked subagent executor. A real
parent Pi loads this repository's extension and calls the public `subagent`
tool. The actual foreground executor or detached background runner launches
the real Pi CLI. A local OpenAI-compatible backend scripts both models, so no
live credentials or provider are needed. The child uses native read/write,
native summarization, and the enabled auto-compact extension. Discovery uses
isolated settings, not `--no-extensions`; the observer only records lifecycle
metadata and the child's exact launch argv. The separate delayed-continuation
fixture models an async input integration (such as a context lookup), without
sending prompts or replacing the installed auto-compact extension.

The summary and continued assistant each take 2.5 seconds, exceeding the
unchanged one-second terminal drain. `delayed-start` additionally spends 2.5
seconds in the real continuation's `input` hook, **after** compaction finishes
but **before** a new `agent_start` or saved user message. The receipt requires
the input hook to finish before that genuine continuation starts.
Timeout and stop interrupt a 12-second summary; `timeout-start` / `stop-start`
interrupt a 12-second continuation input hook after the summary is saved.
The proof requires saved native compaction, retained extension continuation, a completed post-compaction write, exact `PROOF_DONE` child
result, the native final assistant, and terminal status/process receipts.
Final-turn compaction must not resume extra work. Summary failure must recover;
resumed provider failure, timeout, and stop must remain failures. Stop also
checks actual failure delivery after the host consumes its transient result.
`linger` leaves a fixture helper holding child stdout after Pi exits, requires
the real post-exit stdio guard to settle the public call, then reaps the helper.
`shutdown-linger` completes final-turn compaction with no continuation, then
hangs a shutdown handler and ignores SIGTERM. It requires bounded SIGKILL
cleanup after the actual print-host teardown marker. The parent exiting
successfully by itself is not proof of child success.

Captures include command argv, local HTTP requests, parent JSONL, native child
session/transcript, lifecycle observer events, status/results and a failing or
passing `receipt.json`. Keep them outside git. To demonstrate regression, run
the same fixture on the preceding source revision. Before `0fe2a797`, inter-turn
loses the compaction, continuation, write and result; final-turn can return
successful text while silently losing compaction. On `0fe2a797` specifically,
`delayed-start` saves compaction but is killed during continuation preflight,
losing the saved continuation, write and verdict. Keep those failing captures
alongside the fixed runs; do not overwrite receipts.

## Lifecycle correction

`agent_settled` settles a low-level run. Manual `ctx.compact()` aborts that run,
then emits `compaction_start`; its completion callback can start a new run.
Neither `agent_settled`, an assistant `stop`, nor `compaction_end` means the
print host has finished its extension drain. In Pi 0.85.1, `compact()` emits
`compaction_end` before returning to `onComplete`; `sendUserMessage()` then
awaits input hooks, authentication and `before_agent_start` before the new run.
On failure, `compaction_end` can also precede awaited `session_compact_failed`
handlers and `onError`. A delayed provider **response** does not test these gaps.

The required child runtime advertises `subagent_host_lifecycle` version 1,
phase `ready`, on stderr in child JSON mode. Both supervisors share state that
then ignores low-level terminal candidates for cleanup, waiting instead for
phase `shutdown` from `session_shutdown` with reason `quit`. Stderr is deliberate:
Pi redirects extension stdout there and unsubscribes native JSON events before
disposal. Only exact recognized lifecycle records are parsed. Print-host teardown
follows its extension-task drain, covering callbacks and preflight without
coupling supervision to any particular auto-compact extension. Watchdog status
cannot bypass that state. Older runtimes without the handshake retain the
previous settlement/compaction fallback.

No timer is lengthened or removed. Explicit run timeouts, abort/stop,
SIGTERM/SIGKILL escalation, protocol limits, watchdog tails, and post-exit stdio
guards remain in force. A compaction still actively awaiting a provider is
active work: use `timeoutMs` to bound it, just as for an ordinary model request.
Pending callbacks/preflight owned by the print host are active work even when
no agent event is emitted. Arbitrary fire-and-forget tasks not owned by that
host are outside this guarantee. The handshake is not a host-drain patch:
unpatched Pi versions that dispose active extension work remain unsupported.
An extension that never settles before the shutdown marker needs an explicit
run timeout, just like an indefinitely stalled provider.

`npm run test:all` covers the normal baseline. The added unit and foreground/
background integration cases also exercise both settlement/compaction orders,
slow continuation, and final-turn lingering-process cleanup. Existing abort,
timeout, error, watchdog, protocol, and post-exit stdio tests remain applicable.
When running tests from inside a subagent, remove inherited `PI_SUBAGENT*` and
`PI_INTERCOM*` variables from the test subprocess environment; they describe the
caller, not the fixtures. Install development dependencies with
`npm ci --ignore-scripts` if this checkout was installed runtime-only by Pi.
