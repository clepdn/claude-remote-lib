/**
 * Ingress message router — the receive half of the bridge.
 *
 * When the SSE transport delivers a payload, this classifies it and dispatches
 * to the appropriate host callback:
 *   - control_response → onPermissionResponse (a permission decision came back)
 *   - control_request  → onControlRequest  (server asks: initialize / set_model / can_use_tool / interrupt)
 *   - user message      → onInboundMessage    (a user typed something in the Claude app — YOUR code responds)
 *
 * Also performs echo / re-delivery de-dup so the same prompt isn't processed twice.
 */

import {
  isSDKControlRequest,
  isSDKControlResponse,
  isSDKMessage,
  isSDKUserMessage,
  type SDKControlRequest,
  type SDKControlResponse,
  type SDKUserMessage,
} from './types.js'

/** Bounded set for UUID-based dedup (echo suppression + re-delivery guard). */
class BoundedUUIDSet {
  private items: string[] = []
  private set = new Set<string>()
  constructor(private readonly max = 256) {}

  has(id: string): boolean {
    return this.set.has(id)
  }
  add(id: string): void {
    if (this.set.has(id)) return
    this.set.add(id)
    this.items.push(id)
    if (this.items.length > this.max) {
      const old = this.items.shift()!
      this.set.delete(old)
    }
  }
  clear(): void {
    this.set.clear()
    this.items = []
  }
}

export type IngressCallbacks = {
  /** A user message arrived from claude.ai. This is where your inference runs. */
  onInboundMessage: (msg: SDKUserMessage) => void | Promise<void>
  /** A control_request from the server (initialize / set_model / can_use_tool / interrupt). */
  onControlRequest?: (req: SDKControlRequest) => void | Promise<void>
  /** A control_response — e.g. a permission decision you previously requested. */
  onPermissionResponse?: (resp: SDKControlResponse) => void
}

export class IngressRouter {
  private readonly recentPosted = new BoundedUUIDSet()
  private readonly recentInbound = new BoundedUUIDSet()
  private readonly callbacks: IngressCallbacks

  constructor(callbacks: IngressCallbacks) {
    this.callbacks = callbacks
  }

  /** Call this when WE post an outbound message, so its echo can be ignored. */
  markPosted(uuid: string | undefined): void {
    if (uuid) this.recentPosted.add(uuid)
  }

  /** Handle a parsed SSE payload (the SDK message object). */
  handlePayload(payload: unknown): void {
    if (isSDKControlResponse(payload)) {
      this.callbacks.onPermissionResponse?.(payload)
      return
    }
    if (isSDKControlRequest(payload)) {
      this.callbacks.onControlRequest?.(payload)
      return
    }
    if (!isSDKMessage(payload)) return

    const uuid =
      typeof payload === 'object' &&
      payload !== null &&
      'uuid' in payload &&
      typeof (payload as { uuid?: unknown }).uuid === 'string'
        ? ((payload as { uuid: string }).uuid)
        : undefined

    // Drop echoes of our own outbound messages.
    if (uuid && this.recentPosted.has(uuid)) return
    // Drop re-delivered inbound prompts (server replayed history).
    if (uuid && this.recentInbound.has(uuid)) return

    if (isSDKUserMessage(payload)) {
      if (uuid) this.recentInbound.add(uuid)
      void this.callbacks.onInboundMessage(payload)
    }
    // Other inbound types (assistant echoes, system, result) are currently
    // ignored — the bridge is the source of truth for those.
  }

  reset(): void {
    this.recentPosted.clear()
    this.recentInbound.clear()
  }
}
