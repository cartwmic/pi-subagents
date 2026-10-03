#!/usr/bin/env python3
"""Offline public-Pi proof: native foreground/background results and extension drain.

Usage: python3 test/blackbox/pi-1-lifecycle.py [extension-checkout]
Requires the owner's Pi host with waitForExtensionTasks for callback cases.
All providers are scripted; no credentials, model network calls or installed edits.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PROVIDER = r'''
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
export default function(pi) {
 const root=process.env.PROOF_ROOT;
 const scenario=process.env.PROOF_COMPACTION;
 const faux=fauxProvider({provider:'sync-proof',models:[{id:'local'}],tokensPerSecond:100000});
 let requests=0;
 const respond=(context)=>{
  if(++requests>12) throw new Error('Scripted provider request limit exceeded');
  faux.appendResponses([respond]);
  const user=context.messages.filter(m=>m.role==='user').map(m=>JSON.stringify(m.content)).join('\n');
  const tool=context.messages.filter(m=>m.role==='toolResult');
  if(user.includes('CONTINUE_TASK')) return fauxAssistantMessage('CHILD_RESULT_OK');
  if(user.includes('CHILD_TASK')) {
   if(scenario==='success'&&!tool.some(m=>m.toolName==='read')) return fauxAssistantMessage(fauxToolCall('read',{path:root+'/seed.txt'}),{stopReason:'toolUse'});
   return fauxAssistantMessage(scenario==='0'?'CHILD_RESULT_OK':'BEFORE_COMPACTION'+(scenario==='success'?'x'.repeat(40000):''));
  }
  if(tool.length===0) return fauxAssistantMessage(fauxToolCall('subagent',{agent:'proof',task:'CHILD_TASK',async:user.includes('BACKGROUND'),acceptance:false}),{stopReason:'toolUse'});
  if(JSON.stringify(tool).includes('CHILD_RESULT_OK')) return fauxAssistantMessage('PARENT_RECEIVED_CHILD_RESULT_OK');
  if(user.includes('BACKGROUND')) {
   const launch=tool.find(m=>m.toolName==='subagent');
   const waited=tool.find(m=>m.toolName==='bg_wait');
   if(!waited) return fauxAssistantMessage(fauxToolCall('bg_wait',{id:launch.details.asyncId,timeoutMs:20000}),{stopReason:'toolUse'});
   const output=waited.details.completions[0].results[0].artifactPaths.outputPath;
   return fauxAssistantMessage(fauxToolCall('read',{path:output}),{stopReason:'toolUse'});
  }
  return fauxAssistantMessage('PROOF_FAILED: child continuation was lost');
 };
 faux.setResponses([respond]);pi.registerProvider(faux.provider);
 if(scenario!=='0') {
  const log=(type)=>appendFileSync(root+'/lifecycle.jsonl',JSON.stringify({type,at:Date.now()})+'\n');
  let compacted=false,child=false;
  pi.on('before_agent_start',event=>{child=event.systemPrompt.includes('<active_agent name=');});
  pi.on('agent_end',(_event,ctx)=>{
   if(!child||compacted||!JSON.stringify(_event.messages).includes('BEFORE_COMPACTION'))return;
   compacted=true;log('compact-request');
   ctx.compact({onComplete:()=>{log('compact-callback');pi.sendUserMessage('CONTINUE_TASK');},onError:error=>{log('compact-error:'+error.message);pi.sendUserMessage('CONTINUE_TASK');}});
  });
  pi.on('session_before_compact',async event=>{
   log('compact-start');await new Promise(r=>setTimeout(r,1400));log('compact-end');
   return {compaction:{summary:'LOCAL_SUMMARY',firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore}};
  });
  pi.on('input',async event=>{
   if(!child||event.source!=='extension')return;
   log('input-start');await new Promise(r=>setTimeout(r,1400));log('input-end');return {action:'continue'};
  });
  pi.on('session_shutdown',()=>{if(child)log('shutdown');});
 }
}
'''

checkout = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix="pi-subagents-public-proof-", dir="/tmp"))
print(f"Evidence directory: {root}", flush=True)
print(subprocess.check_output(["pi", "--version"], text=True).strip(), flush=True)
provider = root / "provider.ts"
provider.write_text(PROVIDER)
(root / "seed.txt").write_text("seed\n")
failures = 0
for mode in ("FOREGROUND", "BACKGROUND"):
    for scenario in ("0", "success", "error"):
        case = root / f"{mode.lower()}-{scenario}"
        agent = case / "agent"
        project = case / "project"
        (agent / "extensions/subagent").mkdir(parents=True)
        (project / ".pi/agents").mkdir(parents=True)
        (agent / "extensions/subagent/config.json").write_text(json.dumps({"toolActivation": "eager", "maxSubagentDepth": 2}))
        (agent / "settings.json").write_text(json.dumps({"compaction": {"enabled": False, "keepRecentTokens": 32}}))
        (project / ".pi/agents/proof.md").write_text(f"---\nname: proof\ndescription: Offline lifecycle proof\nmodel: sync-proof/local\ntools: read\nextensions: {provider}\ncompletionGuard: false\n---\nReturn the scripted child proof.\n")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("PI_", "HERDR_"))}
        env.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", TMPDIR=str(case), PROOF_ROOT=str(root), PROOF_COMPACTION=scenario)
        command = ["pi", "-ne", "-e", str(checkout), "-e", str(provider), "--provider", "sync-proof", "--model", "local", "--no-session", "-p", f"{mode} proof"]
        print("Command: " + " ".join(command), flush=True)
        try:
            result = subprocess.run(command, cwd=project, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
            output, code = result.stdout, result.returncode
        except subprocess.TimeoutExpired as error:
            output, code = str(error), 124
        (case / "output.log").write_text(output)
        passed = code == 0 and "PARENT_RECEIVED_CHILD_RESULT_OK" in output
        lifecycle = root / "lifecycle.jsonl"
        if scenario != "0":
            events = [json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else []
            types = [event["type"] for event in events]
            passed = passed and "input-end" in types and "shutdown" in types and types.index("input-end") < types.index("shutdown")
            if scenario == "success":
                passed = passed and "compact-callback" in types
            if lifecycle.exists():
                lifecycle.rename(case / "lifecycle.jsonl")
            print("Lifecycle: " + " -> ".join(types), flush=True)
        print(f"{mode}/{scenario}: exit={code} {'PASS' if passed else 'FAIL'}; {output.strip()[:200]}", flush=True)
        failures += not passed
print(f"Black-box: {6 - failures} passed, {failures} failed", flush=True)
sys.exit(1 if failures else 0)
