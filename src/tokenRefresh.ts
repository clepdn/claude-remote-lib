/**
 * Proactive worker-JWT refresh scheduler.
 *
 * The worker_jwt from POST /bridge expires (server returns `expires_in`). We
 * re-fetch credentials before expiry so the SSE stream + writer never see a
 * 401. On refresh the server bumps `worker_epoch`, so the caller must
 * reconnect the transport with the fresh token/epoch.
 *
 * Trimmed from the original `bridge/jwtUtils.ts` createTokenRefreshScheduler —
 * no analytics, no diagnostics, same scheduling semantics.
 */

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry
const FALLBACK_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 min follow-up
const MAX_REFRESH_FAILURES = 3
const REFRESH_RETRY_DELAY_MS = 60_000

export type RefreshResult = {
  worker_jwt: string
  api_base_url: string
  expires_in: number
  worker_epoch: number
}

export type TokenRefreshSchedulerOpts = {
  /** Fetch fresh credentials. Called ~5min before the current token expires. */
  refreshToken: () => Promise<RefreshResult | null>
  /** Called with the fresh credentials so the transport can reconnect. */
  onRefreshed: (result: RefreshResult) => void
  /** Optional override for the pre-expiry buffer (defaults to 5 min). */
  refreshBufferMs?: number
}

export class TokenRefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private generation = 0
  private stopped = false
  private readonly opts: Required<Omit<TokenRefreshSchedulerOpts, 'refreshToken' | 'onRefreshed'>> &
    Pick<TokenRefreshSchedulerOpts, 'refreshToken' | 'onRefreshed'>

  constructor(opts: TokenRefreshSchedulerOpts) {
    this.opts = {
      refreshToken: opts.refreshToken,
      onRefreshed: opts.onRefreshed,
      refreshBufferMs: opts.refreshBufferMs ?? TOKEN_REFRESH_BUFFER_MS,
    }
  }

  /** Schedule using the explicit TTL (seconds) returned by /bridge. */
  scheduleFromExpiresIn(expiresInSeconds: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const gen = ++this.generation
    // Clamp to a 30s floor so a tiny expires_in can't tight-loop.
    const delayMs = Math.max(
      expiresInSeconds * 1000 - this.opts.refreshBufferMs,
      30_000,
    )
    this.timer = setTimeout(() => void this.doRefresh(gen), delayMs)
  }

  private async doRefresh(gen: number): Promise<void> {
    if (this.stopped || gen !== this.generation) return

    let result: RefreshResult | null
    try {
      result = await this.opts.refreshToken()
    } catch {
      result = null
    }
    if (this.stopped || gen !== this.generation) return

    if (!result) {
      this.failures++
      if (this.failures >= MAX_REFRESH_FAILURES) {
        // Give up — caller's onDisconnect will have fired from transport errors.
        return
      }
      this.timer = setTimeout(() => void this.doRefresh(gen), REFRESH_RETRY_DELAY_MS)
      return
    }

    this.failures = 0
    this.opts.onRefreshed(result)

    // Schedule a follow-up so long-running sessions stay authenticated.
    this.timer = setTimeout(
      () => void this.doRefresh(gen),
      FALLBACK_REFRESH_INTERVAL_MS,
    )
  }

  cancel(): void {
    this.stopped = true
    ++this.generation
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
