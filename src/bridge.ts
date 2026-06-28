/**
 * The Bridge — orchestrates the full remote-control lifecycle and exposes the
 * host contract.
 *
 *   ┌────────────┐  OAuth      ┌─────────────┐  worker_jwt  ┌──────────┐
 *   │ your code  │ ──────────▶ │ Claude API  │ ───────────▶ │ worker   │
 *   │ (inference)│ ◀────────── │ /v1/code/   │ ◀────────── │ SSE+POST │
 *   └────────────┘  onInbound  │  sessions   │  assistant   └──────────┘
 *        ▲                        └─────────────┘  message
 *        │  you produce the assistant message with ANY model (or none).
 *
 * What the library does (so you don't):
 *   - create the session + fetch worker credentials (OAuth → worker_jwt)
 *   - hold the SSE read stream (user messages, control_requests)
 *   - heartbeat + worker-state reporting
 *   - proactive JWT refresh (epoch bump + transport swap)
 *   - delivery ACKs + echo dedup
 *
 * What YOU do (the Claude-agnostic part):
 *   - implement `onInboundMessage(msg)` — run whatever inference you want
 *   - call `bridge.send(assistantMessage)` to ship your reply to the server
 *   - call `bridge.respondToPermission(...)` to answer permission prompts
 */

import {
  buildSessionUrl,
  createCodeSession,
  DEFAULT_API_BASE_URL,
  fetchRemoteCredentials,
  registerWorker,
  type RemoteCredentials,
} from './codeSessionApi.js'
import { IngressRouter, type IngressCallbacks } from './ingress.js'
import { TokenRefreshScheduler } from './tokenRefresh.js'
import { CCRTransport, type SessionState } from './transport.js'
import type {
  OutboundMessage,
  PermissionDecision,
  SDKAssistantMessage,
  SDKControlRequest,
  SDKControlResponse,
  SDKUserMessage,
} from './types.js'

export type BridgeHandlers = IngressCallbacks & {
  /** The worker connection is up and the session is visible in claude.ai. */
  onConnect?: () => void
  /** The connection was lost and could not be restored. */
  onDisconnect?: (reason: string) => void
  /** The user hit stop in claude.ai — abort any in-flight work. (auto-acknowledged.) */
  onInterrupt?: () => void
  /** The user switched model in claude.ai. (auto-acknowledged.) */
  onSetModel?: (model: string) => void
  /** The user changed the thinking budget. (auto-acknowledged.) */
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
}

export type BridgeOptions = {
  /**
   * Supplies the claude.ai OAuth access token (used to create the session +
   * fetch worker credentials). Called once at start and again on each refresh.
   */
  getAccessToken: () => string | Promise<string>
  /**
   * Optional trusted-device token — added as X-Trusted-Device-Token on the
   * /bridge call. Required only when the account enforces trusted devices.
   */
  trustedDeviceToken?: string
  /** Sessions API base. Defaults to https://api.anthropic.com. */
  apiBaseUrl?: string
  /** Title shown for the session in claude.ai. */
  title?: string
  /** Optional tags for the session. */
  tags?: string[]
  /** Your inference + control handlers. */
  handlers: BridgeHandlers
  /** Logger. Defaults to a no-op; pass console for visibility. */
  log?: (msg: string) => void
}

export class Bridge {
  private readonly opts: BridgeOptions
  private readonly router: IngressRouter
  private readonly log: (msg: string) => void

  private sessionId: string | null = null
  private workerSessionUrl: string | null = null
  private credentials: RemoteCredentials | null = null
  private transport: CCRTransport | null = null
  private refreshScheduler: TokenRefreshScheduler | null = null
  private started = false
  private stopping = false

  constructor(opts: BridgeOptions) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.router = new IngressRouter({
      onInboundMessage: msg => this.handleInbound(msg),
      onControlRequest: req => this.handleControlRequest(req),
      onPermissionResponse: resp => this.handlePermissionResponse(resp),
    })
  }

  /** The claude.ai session id (cse_*), once start() resolves. */
  get id(): string | null {
    return this.sessionId
  }

  /** The worker session URL (api_base_url + /v1/code/sessions/{id}), once started. */
  get sessionUrl(): string | null {
    return this.workerSessionUrl
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) throw new Error('Bridge already started')
    this.started = true

    const apiBaseUrl = this.opts.apiBaseUrl ?? DEFAULT_API_BASE_URL
    const accessToken = await this.opts.getAccessToken()

    // Step 1 — create the session.
    const sessionId = await createCodeSession(
      apiBaseUrl,
      accessToken,
      this.opts.title ?? 'claude-remote-lib',
      undefined,
      this.opts.tags,
    )
    this.sessionId = sessionId
    this.log(`session created: ${sessionId}`)

    // Step 2 — fetch worker credentials.
    this.credentials = await fetchRemoteCredentials(
      sessionId,
      apiBaseUrl,
      accessToken,
      undefined,
      this.opts.trustedDeviceToken,
    )
    this.workerSessionUrl = buildSessionUrl(
      this.credentials.api_base_url,
      sessionId,
    )
    this.log(`worker epoch=${this.credentials.worker_epoch}, expires_in=${this.credentials.expires_in}s`)

    // Step 2b — register the worker if /bridge didn't hand us an epoch.
    // (The /bridge call normally IS the register; this is the fallback.)
    if (!this.credentials.worker_epoch) {
      const epoch = await registerWorker(this.workerSessionUrl, accessToken)
      this.credentials.worker_epoch = epoch
    }

    // Step 3 — connect the transport + start heartbeat.
    await this.connectTransport()

    // Step 4 — schedule proactive token refresh.
    this.refreshScheduler = new TokenRefreshScheduler({
      refreshToken: () => this.refreshCredentials(),
      onRefreshed: result => this.applyRefreshedCredentials(result),
    })
    this.refreshScheduler.scheduleFromExpiresIn(this.credentials.expires_in)

    this.opts.handlers.onConnect?.()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.refreshScheduler?.cancel()
    this.transport?.close()
    this.transport = null
    this.log('bridge stopped')
  }

  // ─── Host-facing send API ────────────────────────────────────────────────

  /**
   * Push a message to the server (appears in claude.ai). Use this to ship
   * your assistant turns, tool results, stream events, etc.
   *
   * Example — a completed assistant turn:
   * ```ts
   * bridge.send({
   *   type: 'assistant',
   *   message: {
   *     id: 'msg_' + crypto.randomUUID(),
   *     role: 'assistant',
   *     content: [{ type: 'text', text: 'Hello from my own model!' }],
   *     model: 'my-model',
   *     stop_reason: 'end_turn',
   *   },
   * })
   * ```
   */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.transport) throw new Error('Bridge not connected')
    // Inject session_id + uuid if the host omitted them — the server routes
    // events by session_id, and idempotency needs a uuid.
    const enriched = this.enrichOutbound(message)
    this.router.markPosted(enriched.uuid)
    await this.transport.write(enriched)
  }

  /** Convenience: send a plain-text assistant turn. */
  async sendText(text: string, model = 'claude-remote-lib'): Promise<void> {
    const msg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      session_id: this.sessionId ?? undefined,
      parent_tool_use_id: null,
      message: {
        id: `msg_${randomUUID()}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        model,
        stop_reason: 'end_turn',
      },
    }
    await this.send(msg)
  }

  /** Stamp session_id + uuid onto an outbound message if missing. Returns a
   *  NEW object — never mutates the caller's message. */
  private enrichOutbound(message: OutboundMessage): OutboundMessage & { uuid: string } {
    const m = message as Record<string, unknown>
    return {
      ...m,
      uuid: (m.uuid as string | undefined) ?? randomUUID(),
      ...(this.sessionId && !m.session_id ? { session_id: this.sessionId } : {}),
      ...(!('parent_tool_use_id' in m) ? { parent_tool_use_id: null } : {}),
    } as OutboundMessage & { uuid: string }
  }

  /** Build + POST a control_response for an inbound control_request. */
  private async sendControlResponse(
    requestId: string,
    response?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    const msg: SDKControlResponse = error
      ? { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }
      : { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: response ?? {} } }
    await this.transport?.write(msg)
  }

  /** Report worker state to the server (idle / running / requires_action). */
  async reportState(state: SessionState, metadata?: Record<string, unknown>): Promise<void> {
    await this.transport?.reportState(state, metadata)
  }

  /**
   * Respond to a `can_use_tool` permission prompt. Pass the `request_id` from
   * the SDKControlRequest your `onControlRequest` handler received.
   */
  async respondToPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const response: SDKControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: decision.behavior,
          ...(decision.behavior === 'allow'
            ? { updatedInput: decision.updatedInput ?? {} }
            : { message: decision.message }),
        },
      },
    }
    await this.send(response)
  }

  // ─── Internal handlers (dispatched by the router) ────────────────────────

  private async handleInbound(msg: SDKUserMessage): Promise<void> {
    await this.opts.handlers.onInboundMessage(msg)
  }

  private async handleControlRequest(req: SDKControlRequest): Promise<void> {
    // Protocol-level control requests are auto-acknowledged with the shape the
    // server expects (mirrors bridge/bridgeMessaging.ts). Failing to respond
    // promptly hangs the server (~10-14s timeout). `can_use_tool` is the only
    // one that needs a host decision — it's routed to onControlRequest and the
    // host calls respondToPermission().
    const subtype = req.request.subtype
    switch (subtype) {
      case 'initialize':
        await this.sendControlResponse(req.request_id, {
          commands: [],
          output_style: 'normal',
          available_output_styles: ['normal'],
          models: [],
          account: {},
          pid: process.pid,
        })
        break
      case 'set_model':
        this.opts.handlers.onSetModel?.((req.request as { model: string }).model)
        await this.sendControlResponse(req.request_id)
        break
      case 'set_max_thinking_tokens':
        this.opts.handlers.onSetMaxThinkingTokens?.(
          (req.request as { max_tokens: number | null }).max_tokens,
        )
        await this.sendControlResponse(req.request_id)
        break
      case 'interrupt':
        this.opts.handlers.onInterrupt?.()
        await this.sendControlResponse(req.request_id)
        break
      case 'set_permission_mode':
        await this.sendControlResponse(req.request_id)
        break
      case 'can_use_tool':
        // Host decides — must call respondToPermission(request_id, decision).
        await this.opts.handlers.onControlRequest?.(req)
        break
      default:
        await this.sendControlResponse(
          req.request_id,
          undefined,
          `unsupported control_request subtype: ${subtype}`,
        )
    }
  }

  private handlePermissionResponse(resp: SDKControlResponse): void {
    // Forward to host (e.g. a permission decision came back from the server).
    this.opts.handlers.onPermissionResponse?.(resp)
  }

  // ─── Transport + credential refresh ─────────────────────────────────────

  private async connectTransport(): Promise<void> {
    if (!this.workerSessionUrl || !this.credentials) {
      throw new Error('Cannot connect transport without credentials')
    }
    const currentCreds = this.credentials
    this.transport = new CCRTransport(
      {
        sessionUrl: this.workerSessionUrl,
        getAuthToken: () => this.credentials?.worker_jwt ?? currentCreds.worker_jwt,
        workerEpoch: currentCreds.worker_epoch,
      },
      {
        onPayload: payload => this.router.handlePayload(payload),
        onConnect: () => this.log('transport connected'),
        onDisconnect: reason => {
          this.log(`transport disconnected: ${reason}`)
          this.opts.handlers.onDisconnect?.(reason)
        },
      },
    )
    await this.transport.connect()
  }

  private async refreshCredentials(): Promise<RemoteCredentials | null> {
    if (!this.sessionId) return null
    try {
      const apiBaseUrl = this.opts.apiBaseUrl ?? DEFAULT_API_BASE_URL
      const accessToken = await this.opts.getAccessToken()
      const fresh = await fetchRemoteCredentials(
        this.sessionId,
        apiBaseUrl,
        accessToken,
        undefined,
        this.opts.trustedDeviceToken,
      )
      this.log(`token refreshed: new epoch=${fresh.worker_epoch}`)
      return fresh
    } catch (err) {
      this.log(`token refresh failed: ${errMsg(err)}`)
      return null
    }
  }

  /**
   * A fresh /bridge call bumps worker_epoch, which invalidates the old
   * transport. Swap it for a new one bound to the fresh credentials.
   */
  private async applyRefreshedCredentials(result: RemoteCredentials): Promise<void> {
    this.credentials = result
    // A fresh /bridge call bumps worker_epoch, which invalidates the old
    // transport — swap it for a new one bound to the fresh credentials.
    const old = this.transport
    this.transport = null
    old?.close()
    await this.connectTransport()
    // Re-schedule the NEXT refresh from the new token's TTL, so long-running
    // sessions stay authenticated past the first refresh window.
    this.refreshScheduler?.scheduleFromExpiresIn(result.expires_in)
  }
}

function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
