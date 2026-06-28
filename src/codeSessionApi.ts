/**
 * HTTP wrappers for the CCR v2 code-session API.
 *
 * Ported from the original `bridge/codeSessionApi.ts` and `bridge/workSecret.ts`
 * but reimplemented with global `fetch` (zero dependencies) and no logging /
 * analytics coupling. Callers supply explicit `accessToken` + `baseUrl` — no
 * implicit auth or config reads.
 */

const ANTHROPIC_VERSION = '2023-06-01'

export const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'

/** Default per-session timeout (24 hours). */
export const DEFAULT_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

function workerHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/**
 * Step 1 — POST /v1/code/sessions
 * Creates a code session. The `bridge: {}` body is a positive signal for the
 * server's runner oneof (omitting it now 400s). Returns the `cse_*` session id.
 */
export async function createCodeSession(
  baseUrl: string,
  accessToken: string,
  title: string,
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
  tags?: string[],
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/code/sessions`
  const response = await fetch(url, {
    method: 'POST',
    headers: oauthHeaders(accessToken),
    body: JSON.stringify({
      title,
      bridge: {},
      ...(tags?.length ? { tags } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    throw new Error(
      `createCodeSession failed ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = (await response.json()) as {
    session?: { id?: unknown }
  }
  const id = data?.session?.id
  if (typeof id !== 'string' || !id.startsWith('cse_')) {
    throw new Error(
      `createCodeSession: no session.id (cse_*) in response: ${JSON.stringify(data).slice(0, 200)}`,
    )
  }
  return id
}

export type RemoteCredentials = {
  worker_jwt: string
  api_base_url: string
  expires_in: number
  worker_epoch: number
}

/**
 * Step 2 — POST /v1/code/sessions/{id}/bridge
 * Returns worker credentials. Each call bumps the server-side worker_epoch
 * (the /bridge call IS the register). The JWT is opaque — do not decode it
 * except to read `exp` for refresh scheduling.
 */
export async function fetchRemoteCredentials(
  sessionId: string,
  baseUrl: string,
  accessToken: string,
  timeoutMs: number = 30_000,
  trustedDeviceToken?: string,
): Promise<RemoteCredentials> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/code/sessions/${sessionId}/bridge`
  const headers = oauthHeaders(accessToken)
  if (trustedDeviceToken) {
    headers['X-Trusted-Device-Token'] = trustedDeviceToken
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    throw new Error(
      `fetchRemoteCredentials (/bridge) failed ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = (await response.json()) as Record<string, unknown>
  if (
    typeof data.worker_jwt !== 'string' ||
    typeof data.expires_in !== 'number' ||
    typeof data.api_base_url !== 'string' ||
    (typeof data.worker_epoch !== 'number' &&
      typeof data.worker_epoch !== 'string')
  ) {
    throw new Error(
      `fetchRemoteCredentials: malformed response (need worker_jwt, expires_in, api_base_url, worker_epoch): ${JSON.stringify(data).slice(0, 200)}`,
    )
  }

  // protojson may serialize int64 as a string.
  const epoch =
    typeof data.worker_epoch === 'string'
      ? Number(data.worker_epoch)
      : (data.worker_epoch as number)

  return {
    worker_jwt: data.worker_jwt,
    api_base_url: data.api_base_url,
    expires_in: data.expires_in,
    worker_epoch: epoch,
  }
}

/**
 * Build the worker session URL: `{api_base_url}/v1/code/sessions/{id}`.
 * Worker endpoints (SSE stream, /worker/events, /worker/heartbeat, /worker)
 * hang off this base.
 */
export function buildSessionUrl(
  apiBaseUrl: string,
  sessionId: string,
): string {
  const base = apiBaseUrl.replace(/\/+$/, '')
  return `${base}/v1/code/sessions/${sessionId}`
}

/**
 * Step 2b (only when /bridge did NOT already return a worker_epoch) —
 * POST {sessionUrl}/worker/register → worker_epoch.
 */
export async function registerWorker(
  sessionUrl: string,
  accessToken: string,
  timeoutMs: number = 10_000,
): Promise<number> {
  const response = await fetch(`${sessionUrl}/worker/register`, {
    method: 'POST',
    headers: workerHeaders(accessToken),
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`registerWorker failed ${response.status}`)
  }
  const data = (await response.json()) as { worker_epoch?: unknown }
  const epoch =
    typeof data.worker_epoch === 'string'
      ? Number(data.worker_epoch)
      : data.worker_epoch
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch)) {
    throw new Error(`registerWorker: invalid worker_epoch: ${JSON.stringify(data)}`)
  }
  return epoch
}

async function safeErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as unknown
    if (data && typeof data === 'object' && 'error' in data) {
      const err = (data as { error?: unknown }).error
      if (typeof err === 'object' && err !== null && 'message' in err) {
        return String((err as { message?: unknown }).message)
      }
      return JSON.stringify(err)
    }
    if (typeof data === 'string') return data
    return JSON.stringify(data)
  } catch {
    try {
      return await response.text()
    } catch {
      return undefined
    }
  }
}
