# dori-acp — ACP v1 agent backed by local senpi

Date: 2026-11-02
Working dir: `C:/Users/USER/.dori/src/skills/dori-mode/scripts`
Branch: `main`
Commit: `feat(dori-mode): speak ACP so GOAT can render Dori` (feature); `fix(dori-mode): retry atomic registry renames on Windows` (test-stability fix)

## Goal

`dori acp` speaks Agent Client Protocol v1 on stdio so GOAT can register Dori as
`Settings → Providers → Add provider → Local ACP command` (`dori acp`). Every
conversation is executed by a local `senpi --mode rpc` child. GOAT's own Dori
provider is never used as the backend.

## Protocol mapping

| ACP method / notification | Implementation | Behavior |
| --- | --- | --- |
| `initialize` | `src/acp/server.ts` → `initializeResult()` | Returns `protocolVersion: 1`, text-only prompt capabilities, `sessionCapabilities.close`, `agentInfo {name:"dori-acp",title:"Dori",version:"0.1.0"}`, `authMethods: []`. |
| `session/new` | `AcpServer.newSession()` | Validates an absolute `cwd`, creates a backend for that cwd, returns a unique `sess_<uuid>` id. `mcpServers` is accepted and ignored. |
| `session/prompt` | `AcpServer.prompt()` + `SenpiBackend.prompt()` | Concatenates text blocks, sends one senpi `prompt`, forwards every `assistantMessageEvent.text_delta` as a `session/update` notification with `sessionUpdate:"agent_message_chunk"` and `content:{type:"text",text}`, then answers `PromptResponse` with `stopReason:"end_turn"`. |
| `session/cancel` | `AcpServer.cancel()` + `SenpiBackend.cancel()` | Sends senpi `abort` (`awaitIdle`, 5s grace); the pending `session/prompt` answers `stopReason:"cancelled"`. A 10s fallback tree-kills a wedged child. |
| `session/close` | `AcpServer.closeSession()` + `SenpiBackend.close()` | Cancels any turn, closes stdin, waits, then tree-kills the child (`taskkill /PID <pid> /T /F` on Windows, process-group kill on POSIX). Returns `{}`. |
| any other method | `AcpServer.dispatch()` | JSON-RPC error `-32601` (`Method not found`). |
| `session/update` (agent → client) | `SenpiBackend` → `AcpServer` | One notification per text delta, written before the prompt response. |

JSON-RPC framing is LF-delimited JSON (`LineFramer`, persistent UTF-8 decoder).
stdout carries protocol records only; all diagnostics go to stderr.

## Backend and loop guard

- One `senpi --mode rpc --model <~/.dori/config.json defaultModel> --permission-preset full-access`
  child per ACP session, with the ACP `cwd` as the child working directory.
- The child is spawned lazily on the first prompt and stays alive for subsequent
  prompts in the same ACP session, so conversation context is preserved.
- `assertLocalModel()` hard-refuses a `goat/...` or `dori/...` provider. The
  backend never calls GOAT; it only spawns the local senpi executable.
- `SENPI_CHILD pid=<pid>` is logged to stderr for cleanup proof. No token or
  prompt content is logged.
- Child cleanup: `session/close`, ACP stdin EOF, SIGINT and SIGTERM all await
  backend close, which kills the child process tree. The integration test reads
  the PID back from stderr and checks the process list after exit.

## Files

- `src/acp/protocol.ts` — ACP types, `LineFramer`, initialize response, prompt text extraction, JSON-RPC helpers.
- `src/acp/backend.ts` — senpi RPC backend, model guard, tree kill.
- `src/acp/server.ts` — session map and JSON-RPC dispatch.
- `src/acp.ts` — `runAcp()` stdio entry and signal/EOF shutdown.
- `src/cli.ts` — additive `acp` command, usage line, `AcpError` catch.
- `test/acp.test.ts` — unit and backend-adapter tests.
- `test/acp.integration.test.ts` — spawned `dori acp` end-to-end with a fake senpi child.
- `test/acp.real.test.ts` — gated real-model end-to-end and cancel tests.
- `test/acp-harness.ts`, `test/fixtures/fake-senpi.ts` — test harness and deterministic child.

## Commands run

```text
bun test
bunx tsc --noEmit
bun test test/acp.test.ts
bun test test/acp.integration.test.ts
DORI_ACP_REAL=1 bun test test/acp.real.test.ts
```

## Test output summary

Baseline before changes:

```text
79 pass, 0 fail, 280 expect() calls, 9 files, 1244ms
bunx tsc --noEmit: exit 0
```

ACP unit + backend tests:

```text
11 pass, 0 fail, 34 expect() calls, 1 file
```

Spawned ACP integration (fake senpi child):

```text
1 pass, 0 fail, 9 expect() calls
dori acp speaks ACP end to end through a spawned process and reaps its child
```

Real-model run (`DORI_ACP_REAL=1 bun test test/acp.real.test.ts`):

```text
2 pass, 0 fail, 7 expect() calls, 25.34s
(pass) a spawned dori acp answers a real model prompt with DORI_ACP_OK [15288.01ms]
(pass) session/cancel stops a real model turn with the cancelled stop reason [9997.23ms]
```

The real tests use a temporary config with `defaultModel: "opencode-go/claude-haiku-5-5"`
to keep the paid run bounded; production reads `~/.dori/config.json`'s
`defaultModel` unchanged. The earlier probe against the machine's configured
`opencode-go/deepseek-v4.1-flash` showed the same senpi RPC stream but the model
spent the 90s probe on tool calls, so the acceptance test pins a fast model.

Final full suite with the real tests enabled:

```text
93 pass, 0 fail, 0 skip, 312 expect() calls
Ran 93 tests across 12 files. [23.76s]
bunx tsc --noEmit: exit 0
```

Three isolated `bun test test/done-flow.test.ts` runs after the registry fix:
11 pass / 0 fail each.

## Child cleanup evidence

The integration test records the child PID from stderr, asserts it is alive
while the session is open, calls `session/close`, exits the ACP process, then:

1. `isPidAlive(pid)` is `false`.
2. `tasklist /FI "PID eq <pid>"` returns `No tasks are running which match the
   specified criteria` (Windows).

Observed on a manual spawned-process QA run:

```text
STREAMED=DORI_ACP_OK
PID=17748
PID_ALIVE_BEFORE=true
TASKLIST_BEFORE=exit=0 Image Name PID Session Name Session# Mem Usage ========================= ======== ================ =========== ============ bun.exe 17748 Console 1 51,924 K
PID_ALIVE_AFTER=false
TASKLIST_AFTER=exit=0 INFO: No tasks are running which match the specified criteria.
```

A post-suite PowerShell query for processes whose command line contains
`--mode rpc` returned none.

## Test-stability fix outside ACP

`test/done-flow.test.ts` intermittently failed on Windows with
`EPERM: operation not permitted, rename ...` in `Registry.write()`. The write
used a PID-only temp name and renamed over an existing lane file. The fix uses a
unique temp name per write and retries `EPERM`/`EBUSY`/`EACCES` up to eight
times before failing; the successful path is still temp-file + rename, so
readers never see a half-written lane. This is behavior-preserving for every
CLI command and was required to make `bun test` reliable on this workstation.

## GOAT manual registration

Only a person can add and activate a provider in GOAT:

1. Open `Settings → Providers → Add provider → Local ACP command`.
2. Name: `Dori`.
3. Command: `dori`.
4. Args: `acp`.
5. Save and activate the provider.

No GOAT registration was automated from this lane.

## Limitations

- Only text content blocks are forwarded. ACP images, audio and resource blocks
  are not sent to senpi; the agent advertises text-only prompt capabilities.
- `session/load`, `session/list`, `session/delete` and `session/resume` are not
  implemented; unknown methods return `-32601`.
- senpi permission dialogs are suppressed with `--permission-preset full-access`,
  matching the existing GOAT engine's `full-access` runtime mode.
- `DORI_ACP_SENPI` accepts a JSON argv array for tests; production leaves it
  unset and spawns the local `senpi` executable. The model-provider loop guard
  still refuses `goat/*` and `dori/*`.
