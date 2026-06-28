# claude-remote-lib

A **Claude-agnostic** bridge library: speaks Claude's remote-control server
protocol so your own code can appear as a session in the Claude app / claude.ai,
**without calling Claude inference**. You provide the model (any model, or none);
the library handles the wire protocol.

```
   ┌────────────┐  OAuth       ┌─────────────┐  worker_jwt  ┌──────────┐
   │ your code │ ───────────▶ │ Claude API  │ ───────────▶ │  worker  │
   │ (inference)│ ◀──────────  │ /v1/code/   │ ◀──────────  │ SSE+POST │
   └────────────┘  onInbound   │  sessions   │  assistant    └──────────┘
        ▲                         └─────────────┘  message
        │  you produce the reply with ANY model. The library never touches Claude the model.
```

## What it does (so you don't)

- Creates a code session + fetches worker credentials (OAuth → `worker_jwt`)
- Holds the SSE read stream (user messages + control requests from claude.ai)
- Heartbeats + worker-state reporting (`idle` / `running` / `requires_action`)
- Proactive JWT refresh (epoch bump + transport swap)
- Delivery ACKs + echo/re-delivery de-dup
- Permission prompt brokering

## What YOU do (the Claude-agnostic seam)

- Implement `onInboundMessage(msg)` → run whatever inference you want
- Call `bridge.send(assistantMessage)` to ship your reply to the server
- Call `bridge.respondToPermission(...)` to answer permission prompts

## Install

```bash
npm install claude-remote-lib    # (or local: npm install && npm run build)
```

Requires Node ≥ 18.17 (native `fetch` + streaming). Zero runtime dependencies.

## Usage

```ts
import { Bridge } from 'claude-remote-lib'

const bridge = new Bridge({
  // claude.ai OAuth access token — used ONLY to create the session +
  // fetch worker credentials. Never used for inference.
  getAccessToken: () => process.env.CLAUDE_OAUTH_TOKEN!,
  title: 'my-agent',
  log: msg => console.error(`[bridge] ${msg}`),
  handlers: {
    // A user typed something in the Claude app. Run YOUR inference.
    onInboundMessage: async msg => {
      const text = typeof msg.message.content === 'string'
        ? msg.message.content
        : msg.message.content.map(b => b.type === 'text' ? b.text : '').join('')

      const reply = await myModel.generate(text)   // ANY model

      // Ship the reply — it appears in claude.ai.
      await bridge.sendText(reply)
      // or, for full control (tool calls, streaming, usage):
      // await bridge.send({ type: 'assistant', message: { ... } })
    },
    onControlRequest: async req => {
      // Permission prompts ("may I run this tool?"). Wire to your policy.
      await bridge.respondToPermission(req.request_id, { behavior: 'deny', message: 'no tools' })
    },
    onConnect: () => console.log('live in claude.ai'),
    onDisconnect: reason => console.error('disconnected:', reason),
  },
})

await bridge.start()
console.log('session url:', bridge.sessionUrl)
```

See [`examples/echo-bot.ts`](examples/echo-bot.ts) for a complete runnable example
that echoes messages back using **no Claude inference at all**.

```bash
CLAUDE_OAUTH_TOKEN=sk-ant-... npx tsx examples/echo-bot.ts
```

## API

### `Bridge`

| Method | Description |
|---|---|
| `new Bridge(opts)` | Construct with `getAccessToken` + `handlers`. |
| `bridge.start()` | Create session, fetch creds, connect transport, start heartbeat + refresh. |
| `bridge.stop()` | Tear down transport + cancel refresh. |
| `bridge.send(message)` | Push any `OutboundMessage` (assistant / user / stream_event / result / system / control_response) to the server. |
| `bridge.sendText(text, model?)` | Convenience: a completed assistant text turn. |
| `bridge.respondToPermission(requestId, decision)` | Answer a `can_use_tool` prompt. `decision = { behavior: 'allow', updatedInput? } \| { behavior: 'deny', message }`. |
| `bridge.reportState(state, metadata?)` | Tell the server `idle` / `running` / `requires_action`. |
| `bridge.id` | The `cse_*` session id. |
| `bridge.sessionUrl` | The worker session URL. |

### Host contract (`handlers`)

```ts
{
  onInboundMessage: (msg: SDKUserMessage) => void | Promise<void>  // required
  onControlRequest?: (req: SDKControlRequest) => void | Promise<void>  // can_use_tool — host decides, calls respondToPermission()
  onPermissionResponse?: (resp: SDKControlResponse) => void
  onConnect?: () => void
  onDisconnect?: (reason: string) => void
  onInterrupt?: () => void                // user hit stop — auto-acknowledged
  onSetModel?: (model: string) => void  // user switched model — auto-acknowledged
  onSetMaxThinkingTokens?: (n: number | null) => void  // auto-acknowledged
}
```

Protocol-level control requests (`initialize`, `set_model`, `set_max_thinking_tokens`,
`interrupt`, `set_permission_mode`) are **auto-acknowledged** by the library with
the response shape the server expects — you only need to handle `can_use_tool`
(permission prompts) via `onControlRequest` + `respondToPermission()`.

### Wire types

The library re-exports the message shapes (`SDKUserMessage`, `SDKAssistantMessage`,
`ContentBlock`, `ToolUseBlock`, `SDKControlRequest`, `SDKControlResponse`, …).
Your code must emit these shapes to be understood by the server — that's coupling
to Claude's *wire format*, not to Claude *inference*.

## Protocol reference (v2 code sessions)

The library implements the CCR v2 dance, extracted from the Claude Code source:

```
1. POST   {api}/v1/code/sessions              (OAuth Bearer)  → {session:{id:"cse_*"}}
2. POST   {api}/v1/code/sessions/{id}/bridge   (OAuth Bearer) → {worker_jwt, api_base_url, expires_in, worker_epoch}
   (each /bridge call bumps worker_epoch — it IS the register)
3. GET    {api_base_url}/v1/code/sessions/{id}/worker/events/stream  (Bearer worker_jwt)  ← SSE read
   POST   …/worker/events           {worker_epoch, events:[{payload}]}   ← write outbound
   POST   …/worker/heartbeat        {session_id, worker_epoch}           ← liveness (20s)
   PUT    …/worker                  {worker_status, worker_epoch, external_metadata}
   POST   …/worker/events/delivery  {worker_epoch, updates:[{event_id,status}]}
```

Auth header everywhere: `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01`.

## Status & caveats

✅ **Verified against production.** The protocol chain has been exercised
end-to-end against the live Claude servers with a real claude.ai OAuth token:

- `POST /v1/code/sessions` → `cse_*` id
- `POST /v1/code/sessions/{id}/bridge` → `worker_jwt` + `api_base_url` + `worker_epoch` (the `/bridge` call IS the register)
- `PUT /worker` (register idle) → `200`
- `POST /worker/events` with an assistant payload → `200` (accepted, **rendered in the Claude app**)
- `GET /worker/events/stream` → `200` SSE; inbound user messages received
- Control requests (`initialize`, …) answered → `200`
- Full loop: user typed in claude.ai → SSE delivered it → host replied → reply rendered in the app. **No Claude inference anywhere.**

The `Bridge` class mirrors the verified standalone probe (`scripts/probe-worker.mjs`, `scripts/e2e-listen.mjs`) but has not itself been run live as a unit — the logic is identical, so behavior should transfer. If something doesn't connect, the likely culprits are the base URL (`apiBaseUrl`, defaults to `https://api.anthropic.com`), a missing `trustedDeviceToken`, or an expired OAuth token (the probes refresh automatically).

## License

MIT.
