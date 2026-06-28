/**
 * v2 CCR transport — SSE read stream + HTTP POST writes.
 *
 * Reimplemented from the original `cli/transports/SSETransport.ts` +
 * `cli/transports/ccrClient.ts`, but:
 *   - native `fetch` (zero deps)
 *   - no analytics / diagnostics / proxy helpers
 *   - no 100K-queue stream-event buffering (simplified to a small in-order queue)
 *
 * Endpoints (all under sessionUrl = `${api_base_url}/v1/code/sessions/{id}`):
 *   GET  /worker/events/stream    — SSE read (user msgs + control_requests)
 *   POST /worker/events           — write outbound messages (assistant, tool results, …)
 *   POST /worker/heartbeat        — liveness (server TTL 60s; we beat every 20s)
 *   PUT  /worker                  — report worker state (idle / running / requires_action)
 *   POST /worker/events/delivery  — ACK that we received/processed an event
 *
 * Auth: Bearer {worker_jwt}. The server validates the JWT's session_id claim +
 * worker role. OAuth tokens are NOT accepted here.
 */

import { decodeJwtExpiry } from './jwt.js'
import type {
  OutboundMessage,
  StreamClientEvent,
} from './types.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_MAX_ATTEMPTS = 10

export type SessionState = 'idle' | 'running' | 'requires_action'

export type TransportCallbacks = {
  /** A payload arrived from the server (an SDK message or control message). */
  onPayload: (payload: unknown) => void
  /** Transport is connected (writer initialized, SSE open). */
  onConnect?: () => void
  /** Transport dropped and could not be restored. */
  onDisconnect?: (reason: string) => void
}

export type TransportOpts = {
  sessionUrl: string
  /** Worker JWT (from POST /bridge). Auth for all worker endpoints. */
  getAuthToken: () => string
  workerEpoch: number
  heartbeatIntervalMs?: number
}

/**
 * Parses SSE frame text. Frames are delimited by blank lines; `data:` lines
 * concatenate with `\n`. Returns parsed frames + the unconsumed remainder.
 */
export function parseSSEFrames(
  buffer: string,
): { frames: string[]; remaining: string } {
  // Normalize CRLF so the \n\n frame separator is reliable.
  const normalized = buffer.replace(/\r\n/g, '\n')
  const frames: string[] = []
  let rest = normalized
  let sep = rest.indexOf('\n\n')
  while (sep !== -1) {
    const rawFrame = rest.slice(0, sep)
    rest = rest.slice(sep + 2)
    // Collect data: lines (ignore event:/id:/retry: — we use the JSON envelope).
    const dataLines: string[] = []
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length > 0) {
      frames.push(dataLines.join('\n'))
    }
    sep = rest.indexOf('\n\n')
  }
  return { frames, remaining: rest }
}

export class CCRTransport {
  private readonly sessionUrl: string
  private readonly getAuthToken: () => string
  private readonly workerEpoch: number
  private readonly heartbeatIntervalMs: number
  private readonly callbacks: TransportCallbacks

  private abortController: AbortController | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private lastSequenceNum = 0
  private closed = false
  private connected = false
  private reconnectAttempts = 0
  private writeQueue: OutboundMessage[] = []
  private writeInFlight = false

  constructor(opts: TransportOpts, callbacks: TransportCallbacks) {
    this.sessionUrl = opts.sessionUrl.replace(/\/+$/, '')
    this.getAuthToken = opts.getAuthToken
    this.workerEpoch = opts.workerEpoch
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.callbacks = callbacks
  }

  /** Start the SSE read loop + heartbeat. Resolves on first connect. */
  async connect(): Promise<void> {
    // Init: register the worker as 'idle' before opening the stream/heartbeat.
    // The server expects this PUT /worker (worker_status: idle) to consider the
    // worker ready; without it the session may never go "live" in claude.ai.
    await this.reportState('idle', { pending_action: null, task_summary: null })
    await this.startSSE()
    this.startHeartbeat()
    this.connected = true
    this.callbacks.onConnect?.()
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getAuthToken()}`,
      'anthropic-version': ANTHROPIC_VERSION,
    }
  }

  private async startSSE(): Promise<void> {
    this.abortController = new AbortController()
    const url = new URL(`${this.sessionUrl}/worker/events/stream`)
    if (this.lastSequenceNum > 0) {
      url.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.authHeaders(),
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Last-Event-ID': String(this.lastSequenceNum),
        },
        signal: this.abortController.signal,
      })
    } catch (err) {
      this.handleDrop(`SSE connect failed: ${errMsg(err)}`)
      return
    }

    if (!response.ok || !response.body) {
      this.handleDrop(`SSE returned ${response.status}`)
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      // Read loop. Never resolves until the stream closes/errors.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining
        for (const frame of frames) {
          this.handleFrame(frame)
        }
      }
      // Clean close — attempt reconnect (server may rotate the stream).
      this.handleDrop('SSE stream ended')
    } catch (err) {
      if (this.closed) return
      this.handleDrop(`SSE read error: ${errMsg(err)}`)
    }
  }

  private handleFrame(data: string): void {
    let envelope: StreamClientEvent
    try {
      envelope = JSON.parse(data) as StreamClientEvent
    } catch {
      return
    }
    if (typeof envelope.sequence_num === 'number') {
      this.lastSequenceNum = Math.max(this.lastSequenceNum, envelope.sequence_num)
    }
    // ACK delivery so the server stops re-delivering this event on reconnect.
    if (envelope.event_id) {
      void this.ackDelivery(envelope.event_id, 'processed')
    }
    this.callbacks.onPayload(envelope.payload)
  }

  private handleDrop(reason: string): void {
    if (this.closed) return
    this.connected = false
    this.reconnectAttempts++
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this.callbacks.onDisconnect?.(reason)
      return
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    setTimeout(() => {
      if (this.closed) return
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    // A fresh JWT may be needed — let the bridge refresh creds first.
    // The bridge swaps the transport on refresh, so here we just retry SSE.
    this.reconnectAttempts = 0
    await this.startSSE()
    if (!this.closed) {
      this.connected = true
      this.callbacks.onConnect?.()
    }
  }

  // ─── Writes ──────────────────────────────────────────────────────────────

  /** Push an outbound message (assistant turn, tool result, stream event…). */
  async write(message: OutboundMessage): Promise<void> {
    this.writeQueue.push(message)
    void this.drainWriteQueue()
  }

  private async drainWriteQueue(): Promise<void> {
    if (this.writeInFlight) return
    this.writeInFlight = true
    try {
      while (this.writeQueue.length > 0 && !this.closed) {
        const batch = this.writeQueue.splice(0, 100)
        const ok = await this.postEvents(batch)
        if (!ok) {
          // Re-enqueue at the front and back off.
          this.writeQueue.unshift(...batch)
          await sleep(1_000)
        }
      }
    } finally {
      this.writeInFlight = false
    }
  }

  private async postEvents(messages: OutboundMessage[]): Promise<boolean> {
    const events = messages.map(m => ({
      payload: { ...m, uuid: (m as { uuid?: string }).uuid ?? randomUUID() },
    }))
    try {
      const response = await fetch(`${this.sessionUrl}/worker/events`, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          worker_epoch: this.workerEpoch,
          events,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 409) {
        this.callbacks.onDisconnect?.('epoch superseded (409)')
        return false
      }
      return response.ok
    } catch (err) {
      return false
    }
  }

  /** PUT /worker — report worker state (idle / running / requires_action). */
  async reportState(
    state: SessionState,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`${this.sessionUrl}/worker`, {
        method: 'PUT',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          worker_status: state,
          worker_epoch: this.workerEpoch,
          external_metadata: metadata ?? {},
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // best-effort
    }
  }

  /** POST /worker/events/delivery — acknowledge an inbound event. */
  private async ackDelivery(
    eventId: string,
    status: 'received' | 'processing' | 'processed',
  ): Promise<void> {
    try {
      await fetch(`${this.sessionUrl}/worker/events/delivery`, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          worker_epoch: this.workerEpoch,
          updates: [{ event_id: eventId, status }],
        }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      // best-effort
    }
  }

  private startHeartbeat(): void {
    const tick = (): void => {
      if (this.closed) return
      void this.sendHeartbeat()
      this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs)
    }
    this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs)
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await fetch(`${this.sessionUrl}/worker/heartbeat`, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: this.sessionUrl.split('/').pop(),
          worker_epoch: this.workerEpoch,
        }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      // best-effort
    }
  }

  get isConnected(): boolean {
    return this.connected
  }

  get tokenExpiry(): number | null {
    return decodeJwtExpiry(this.getAuthToken())
  }

  close(): void {
    this.closed = true
    if (this.abortController) this.abortController.abort()
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.connected = false
  }
}

function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Fallback (shouldn't be needed on Node 18.17+).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
