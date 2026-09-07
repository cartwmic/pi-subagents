#!/usr/bin/env python3
"""Real Pi -> public subagent tool -> real Pi, with a local scripted backend.

Requires the installed Pi headless-extension-drain fix and enabled auto-compact.
No credentials or live models. All captures stay outside the repository.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--pi', default=shutil.which('pi'))
    parser.add_argument('--extension', type=Path, default=Path.home() / '.pi/agent/extensions/auto-compact/index.ts')
    parser.add_argument('--mode', choices=['foreground', 'background'], default='background')
    parser.add_argument('--scenario', choices=['inter-turn', 'final-turn', 'resume-error', 'summary-error', 'timeout', 'stop', 'linger', 'delayed-start', 'timeout-start', 'stop-start', 'shutdown-linger'], default='inter-turn')
    parser.add_argument('--start-delay-ms', type=int, default=0, help='Delay real extension continuation input preflight')
    args = parser.parse_args()
    start_delay_ms = max(args.start_delay_ms, 12000 if args.scenario in ('timeout-start', 'stop-start') else 2500 if args.scenario == 'delayed-start' else 0)
    root = args.artifacts.resolve()
    assert not root.is_relative_to(REPO), 'Captures must stay outside git'
    root.mkdir(parents=True, exist_ok=False)
    agent, work = root / 'agent', root / 'work'
    agent.mkdir()
    (work / '.pi/agents').mkdir(parents=True)
    (work / 'payload.txt').write_text('x' * 12371)
    (work / '.pi/agents/probe.md').write_text(f'''---
name: probe
description: Local compaction fixture
tools: read, write
model: proof/scripted
subagentOnlyExtensions: {REPO / 'test/blackbox/lifecycle-observer.ts'}, {REPO / 'test/blackbox/delayed-continuation.ts'}
completionGuard: false
---
Follow the scripted task.
''')
    # Only isolate discovery; the actual deployed auto-compact stays enabled,
    # with its unchanged threshold, continuation and circuit breaker.
    (agent / 'settings.json').write_text(json.dumps({
        'extensions': [str(REPO / 'index.ts'), str(args.extension.resolve())],
        'packages': [], 'defaultProjectTrust': 'always',
        'compaction': {'enabled': True}, 'retry': {'enabled': False},
        'subagents': {'asyncByDefault': False},
    }))
    requests, errors = [], []
    normal_calls = summary_calls = 0
    child_started = threading.Event()

    class Backend(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            nonlocal normal_calls, summary_calls
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            tools = {t['function']['name'] for t in body.get('tools', [])}
            parent = 'subagent' in tools
            summary = not tools
            record = {'at': time.time(), 'parent': parent, 'summary': summary, 'body': body}
            requests.append(record)
            (root / 'requests.json').write_text(json.dumps(requests, indent=2))
            finish, usage = 'stop', 1000

            def call(name, params):
                nonlocal finish
                finish = 'tool_calls'
                return {'tool_calls': [{'index': 0, 'id': 'call_' + str(len(requests)), 'type': 'function',
                                       'function': {'name': name, 'arguments': json.dumps(params)}}]}

            if parent:
                results = [m for m in body['messages'] if m['role'] == 'tool']
                if not results:
                    params = {'agent': 'probe', 'task': 'Read payload.txt, preserve history, then write post-compaction.txt and report PROOF_DONE.',
                              'model': 'proof/scripted', 'context': 'fresh', 'agentScope': 'project',
                              'async': args.mode == 'background', 'clarify': False, 'acceptance': False,
                              'timeoutMs': 60000}
                    if args.scenario in ('timeout', 'timeout-start'):
                        params['timeoutMs'] = 7000
                    delta = call('subagent', params)
                elif args.mode == 'background' and len(results) == 1:
                    child_started.wait(20)
                    import re
                    text = str(results[-1]['content'])
                    match = re.search(r'\b[a-f0-9]{8}(?:-[a-f0-9-]+)?\b', text)
                    if args.scenario in ('stop', 'stop-start'):
                        if args.scenario == 'stop-start':
                            deadline = time.monotonic() + 20
                            while not (root / 'continuation-preflight.jsonl').exists() and time.monotonic() < deadline:
                                time.sleep(0.05)
                        time.sleep(1)
                        if not match:
                            errors.append('No async id for stop')
                            delta = {'content': 'MISSING_RUN_ID'}
                        else:
                            delta = call('subagent', {'action': 'stop', 'id': match.group()})
                    else:
                        delta = call('subagent_wait', {'id': match.group() if match else 'missing', 'timeoutMs': 65000})
                elif args.mode == 'background' and len(results) == 2:
                    import re
                    match = re.search(r'\b[a-f0-9]{8}(?:-[a-f0-9-]+)?\b', str(results[0]['content']))
                    delta = call('subagent', {'action': 'status', 'id': match.group() if match else 'missing'})
                else:
                    # Let the host observe detached-runner close before print
                    # disposal; stop acknowledges control before process exit.
                    if args.scenario in ('stop', 'stop-start'):
                        time.sleep(1)
                    delta = {'content': 'PARENT_DONE'}
            elif summary:
                summary_calls += 1
                child_started.set()
                time.sleep(12 if args.scenario in ('timeout', 'stop') else 2.5)  # Exceed the old final drain.
                delta = {'content': 'COMPACTION_PROOF_SUMMARY: Read completed. Write post-compaction.txt with POST_COMPACTION_ACTION, then report PROOF_DONE.'}
            else:
                normal_calls += 1
                if normal_calls == 1:
                    usage = 21000
                    delta = call('read', {'path': 'payload.txt'})
                    delta['content'] = 'Retained historical context. ' * 3500
                elif normal_calls == 2:
                    usage = 120515
                    if args.scenario in ('final-turn', 'shutdown-linger'):
                        usage = 123000
                        delta = {'content': 'PROOF_DONE'}
                    else:
                        delta = call('read', {'path': 'payload.txt'})
                elif normal_calls == 3:
                    time.sleep(2.5)  # Slow continued assistant, not merely slow summary.
                    text = json.dumps(body['messages'])
                    if 'compacted' not in text.lower() and 'Continue from where you left off.' not in text:
                        errors.append('No extension continuation in resumed context')
                    if args.scenario != 'summary-error' and 'COMPACTION_PROOF_SUMMARY' not in text:
                        errors.append('No native summary in resumed context')
                    delta = call('write', {'path': 'post-compaction.txt', 'content': 'POST_COMPACTION_ACTION'})
                else:
                    delta = {'content': 'PROOF_DONE'}
            if (summary and args.scenario == 'summary-error') or (not parent and not summary and normal_calls == 3 and args.scenario == 'resume-error'):
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': {'message': 'SCRIPTED_FAILURE', 'type': 'invalid_request_error'}}).encode())
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            chunks = [
                {'choices': [{'index': 0, 'delta': {'role': 'assistant', **delta}, 'finish_reason': None}]},
                {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}], 'usage': {
                    'prompt_tokens': usage, 'completion_tokens': 42, 'total_tokens': usage + 42}},
            ]
            try:
                for chunk in chunks:
                    self.wfile.write(('data: ' + json.dumps({'id': 'proof', 'object': 'chat.completion.chunk', 'model': 'scripted', **chunk}) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'proof': {
        'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'api': 'openai-completions', 'apiKey': 'dummy-local-only',
        'models': [{'id': 'scripted', 'contextWindow': 272000, 'maxTokens': 16384}],
    }}}))
    command = [args.pi, '--mode', 'json', '--print', '--no-skills', '--no-context-files',
               '--model', 'proof/scripted', '--session-dir', str(root / 'sessions'),
               '--system-prompt', 'Use the subagent tool as scripted.', 'Run the compaction probe.']
    (root / 'command.json').write_text(json.dumps(command, indent=2))
    env = {k: v for k, v in os.environ.items() if not k.startswith(('PI_SUBAGENT', 'PI_INTERCOM'))}
    env.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1', PI_TELEMETRY='0',
               TMPDIR=str(root / 'tmp'), HEADLESS_COMPACTION_PROOF_DIR=str(root),
               HEADLESS_COMPACTION_PROOF_LINGER='1' if args.scenario == 'linger' else '0',
               HEADLESS_COMPACTION_PROOF_START_DELAY_MS=str(start_delay_ms),
               HEADLESS_COMPACTION_PROOF_SHUTDOWN_LINGER='1' if args.scenario == 'shutdown-linger' else '0')
    (root / 'tmp').mkdir()
    holder_alive_after_result = False
    try:
        result = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=90)
        (root / 'stdout.jsonl').write_text(result.stdout)
        (root / 'stderr').write_text(result.stderr)
        parent_finished_at = time.time() * 1000
    finally:
        server.shutdown()
        holder_path = root / 'stdio-holder.json'
        if holder_path.exists():
            import signal
            holder_pid = json.loads(holder_path.read_text())['pid']
            try:
                os.kill(holder_pid, 0)
                holder_alive_after_result = True
                os.kill(holder_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    if args.scenario == 'linger' and not holder_alive_after_result:
        errors.append('Fixture did not retain stdout through child exit')
    # Stop acknowledges control before the runner writes its process receipt.
    # Bound observation of teardown; do not count a live child as success.
    lifecycle_path = root / 'child-lifecycle.jsonl'
    lifecycle = [json.loads(line) for line in lifecycle_path.read_text().splitlines()] if lifecycle_path.exists() else []
    pid = next((e.get('pid') for e in lifecycle if e.get('pid')), None)
    if pid:
        deadline = time.monotonic() + 6
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            if time.monotonic() >= deadline:
                errors.append('Child remained alive after terminal workflow')
                import signal
                os.kill(pid, signal.SIGKILL)
                break
            time.sleep(0.05)
    events = []
    for line in result.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    tool_results = [e['message'] for e in events if e.get('type') == 'message_end' and e.get('message', {}).get('role') == 'toolResult']
    (root / 'tool-results.json').write_text(json.dumps(tool_results, indent=2))
    statuses = [json.loads(p.read_text()) for p in root.rglob('status.json') if 'async-subagent-runs' in str(p)]
    (root / 'statuses.json').write_text(json.dumps(statuses, indent=2))
    sessions = [p for p in root.rglob('*.jsonl') if p.name == 'session.jsonl']
    entries = [json.loads(line) for p in sessions for line in p.read_text().splitlines()]
    compactions = [e for e in entries if e.get('type') == 'compaction']
    child_lifecycle_path = root / 'child-lifecycle.jsonl'
    child_lifecycle = [json.loads(line) for line in child_lifecycle_path.read_text().splitlines()] if child_lifecycle_path.exists() else []
    if not child_lifecycle or (args.scenario not in ('timeout', 'stop', 'timeout-start', 'stop-start') and child_lifecycle[-1]['type'] != 'session_shutdown'):
        errors.append('Missing observed child shutdown')
    if len(sessions) != 1:
        errors.append('Expected exactly one native child session')
    failed_scenario = args.scenario in ('resume-error', 'timeout', 'stop', 'timeout-start', 'stop-start')
    if result.returncode != 0 or not any(e.get('message', {}).get('content') == [{'type': 'text', 'text': 'PARENT_DONE'}] for e in events):
        errors.append('Parent public tool workflow did not complete')
    if not tool_results or any(m.get('isError') for m in tool_results) and not failed_scenario:
        errors.append('Public tool failed')
    payloads = [json.loads(p.read_text()) for p in root.rglob('*.json') if p.parent.name == 'async-subagent-results']
    child_results = payloads[-1].get('results', []) if payloads else (tool_results[0].get('details', {}).get('results', []) if tool_results else [])
    if args.mode == 'background':
        # Delivered background results are consumed by the host's watcher.
        # For stop, its persisted failed step plus the actual completion
        # notification prove delivery even after that transient file is gone.
        if args.scenario in ('stop', 'stop-start') and not payloads and statuses:
            child_results = statuses[0].get('steps', [])
            notifications = [e.get('message', {}) for e in events if e.get('type') == 'message_end' and e.get('message', {}).get('customType') == 'subagent-notify']
            if not any('Subagent stopped by user.' in str(m.get('content')) for m in notifications):
                errors.append('Stopped result was not delivered')
        if (len(payloads) != 1 and args.scenario not in ('stop', 'stop-start')) or len(statuses) != 1 or statuses[0].get('state') not in ('complete', 'failed', 'stopped'):
            errors.append('Missing terminal native background status/result')
        if not list(root.rglob('process-terminal.json')):
            errors.append('Missing native process-terminal receipt')
    attempt = statuses[0]['steps'][0] if statuses else (child_results[0] if child_results else {})
    child_exit = attempt.get('exitCode')
    if attempt.get('attemptedModels') != ['proof/scripted']:
        errors.append('Expected exactly the local scripted model with no fallback')
    if not child_results:
        errors.append('No native child result')
    elif failed_scenario:
        expected = 'SCRIPTED_FAILURE' if args.scenario == 'resume-error' else ('timed out' if args.scenario in ('timeout', 'timeout-start') else 'stopped')
        if child_exit in (0, None) or expected.lower() not in json.dumps(child_results).lower():
            errors.append('Genuine child failure was suppressed: ' + expected)
    elif child_exit != 0 or child_results[0].get('output', child_results[0].get('finalOutput')) != 'PROOF_DONE':
        errors.append('No successful actual child final result')
    if not failed_scenario:
        assistants = [e['message'] for e in entries if e.get('message', {}).get('role') == 'assistant']
        if not assistants or assistants[-1].get('stopReason') != 'stop' or assistants[-1].get('content') != [{'type': 'text', 'text': 'PROOF_DONE'}]:
            errors.append('Native session lacks the actual final assistant verdict')
    if compactions:
        compact_start = next((e['at'] for e in child_lifecycle if e['type'] == 'session_before_compact'), None)
        compact_end = next((e['at'] for e in child_lifecycle if e['type'] == 'session_compact'), None)
        if compact_start is None or compact_end is None or compact_end - compact_start < 2400:
            errors.append('Did not exercise slow real compaction beyond the old drain guard')
    if not failed_scenario or args.scenario == 'resume-error':
        expected_compactions = 0 if args.scenario == 'summary-error' else 1
        if len(compactions) != expected_compactions:
            errors.append(f'Expected {expected_compactions} saved native compactions, got {len(compactions)}')
    if args.scenario in ('inter-turn', 'summary-error', 'linger', 'delayed-start'):
        marker = work / 'post-compaction.txt'
        if not marker.exists() or marker.read_text() != 'POST_COMPACTION_ACTION':
            errors.append('Missing real post-compaction write')
        continuation = [i for i, e in enumerate(entries) if e.get('message', {}).get('role') == 'user' and ('compacted' in json.dumps(e['message']).lower() or 'Continue from where you left off.' in json.dumps(e['message']))]
        writes = [i for i, e in enumerate(entries) if e.get('message', {}).get('role') == 'toolResult' and e['message'].get('toolName') == 'write']
        if len(continuation) != 1 or len(writes) != 1 or continuation[0] >= writes[0]:
            errors.append('Native session lacks retained continuation followed by completed write')
        elif compactions and entries.index(compactions[0]) >= continuation[0]:
            errors.append('Continuation preceded saved compaction')
    if args.scenario in ('final-turn', 'shutdown-linger') and (normal_calls != 2 or (work / 'post-compaction.txt').exists()):
        errors.append('Final-turn compaction resumed spurious work')
    if args.scenario == 'shutdown-linger':
        shutdown_at = next((e['at'] for e in child_lifecycle if e['type'] == 'session_shutdown'), None)
        if shutdown_at is None or not 3500 <= parent_finished_at - shutdown_at < 12000:
            errors.append('Lingering shutdown did not exercise bounded SIGTERM/SIGKILL cleanup')
    if start_delay_ms > 0:
        preflight_path = root / 'continuation-preflight.jsonl'
        preflight = [json.loads(line) for line in preflight_path.read_text().splitlines()] if preflight_path.exists() else []
        compact_end = next((e['at'] for e in child_lifecycle if e['type'] in ('session_compact', 'session_compact_failed')), None)
        starts = [e['at'] for e in child_lifecycle if e['type'] == 'agent_start' and compact_end is not None and e['at'] > compact_end]
        if args.scenario in ('timeout-start', 'stop-start'):
            if len(compactions) != 1 or len(preflight) != 1 or starts or (work / 'post-compaction.txt').exists():
                errors.append('Explicit cancellation did not stop pending post-compaction input')
        elif len(preflight) != 2 or preflight[-1]['at'] - preflight[0]['at'] < start_delay_ms - 100 or not starts or starts[0] < preflight[-1]['at']:
            errors.append('Delayed post-compaction input did not finish before genuine continuation agent_start')
    receipt = {'mode': args.mode, 'scenario': args.scenario, 'start_delay_ms': start_delay_ms, 'exit': result.returncode, 'compactions': len(compactions),
               'normal_requests': normal_calls, 'summary_requests': summary_calls, 'errors': errors,
               'artifacts': str(root), 'sessions': [str(p) for p in sessions]}
    (root / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
