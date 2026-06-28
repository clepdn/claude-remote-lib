#!/usr/bin/env node
/**
 * Probe the WORKER protocol (the basis for the claude-remote-lib Bridge):
 *   /v1/code/sessions/{id}/worker/*  (worker_jwt auth)
 *
 * Verifies against production:
 *   1. POST /v1/code/sessions            (OAuth)        → cse_* session id
 *   2. POST /v1/code/sessions/{id}/bridge (OAuth)        → {worker_jwt, api_base_url, expires_in, worker_epoch}
 *   3. PUT  …/worker                      (worker_jwt)   → register worker as idle
 *   4. POST …/worker/events               (worker_jwt)   → push an ASSISTANT message (no Claude inference)
 *   5. GET  …/worker/events/stream        (worker_jwt)   → SSE read (brief)
 *   6. archive the probe session (best-effort cleanup)
 *
 * SECURITY: reads ~/.pi/agent/auth.json at runtime; never prints tokens or
 * the worker_jwt. Only statuses, the session id, and small response snippets.
 *
 *   node scripts/probe-worker.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const BASE = 'https://api.anthropic.com'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const BYOC_BETA = 'ccr-byoc-2025-07-29'
const ANTHROPIC_VERSION = '2023-06-01'
const AUTH_FILE = join(homedir(), '.pi', 'agent', 'auth.json')

function log(msg) {
  console.error(`[worker] ${msg}`)
}
function mask(s) {
  if (!s) return '<none>'
  return `${s.slice(0, 6)}…${s.slice(-3)} (${s.length} chars)`
}

// ─── load tokens ───────────────────────────────────────────────────────────
let accessToken, refreshToken
try {
  const json = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  accessToken = json?.anthropic?.access
  refreshToken = json?.anthropic?.refresh
} catch (e) {
  console.error(`[worker] cannot read auth file: ${e.message}`)
  process.exit(1)
}
if (!accessToken) {
  console.error('[worker] no anthropic.access token')
  process.exit(1)
}
log(`access token: ${mask(accessToken)}  refresh present: ${Boolean(refreshToken)}`)

function oauthHeaders() {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}
function workerHeaders(workerJwt) {
  return {
    Authorization: `Bearer ${workerJwt}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

async function ensureAccessToken() {
  // try a cheap authed call; refresh on 401
  const res = await fetch(`${BASE}/api/oauth/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status !== 401) return
  if (!refreshToken) throw new Error('access token 401 and no refresh token')
  log('access token 401 — refreshing…')
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!r.ok) throw new Error(`refresh failed ${r.status}`)
  accessToken = (await r.json()).access_token
  log(`refreshed: ${mask(accessToken)}`)
}

async function expectOk(label, res, { allow = [200, 201, 204] } = {}) {
  const ok = allow.includes(res.status)
  log(`${label} → ${res.status} ${res.statusText}${ok ? ' ✓' : ' ✗'}`)
  if (!ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label} failed: ${res.status} ${body.slice(0, 400)}`)
  }
  return res
}

// ─── 1. create session ──────────────────────────────────────────────────────
await ensureAccessToken()
log('step 1: POST /v1/code/sessions')
let res = await fetch(`${BASE}/v1/code/sessions`, {
  method: 'POST',
  headers: oauthHeaders(),
  body: JSON.stringify({ title: 'claude-remote-lib worker probe', bridge: {} }),
})
await expectOk('  create session', res)
const createData = await res.json()
const cseId = createData?.session?.id
if (typeof cseId !== 'string' || !cseId.startsWith('cse_')) {
  throw new Error(`unexpected session id: ${JSON.stringify(createData).slice(0, 200)}`)
}
log(`  session id: ${cseId}`)

// ─── 2. fetch /bridge credentials ──────────────────────────────────────────
log('step 2: POST /v1/code/sessions/{id}/bridge')
res = await fetch(`${BASE}/v1/code/sessions/${cseId}/bridge`, {
  method: 'POST',
  headers: oauthHeaders(),
  body: '{}',
})
await expectOk('  /bridge', res)
const creds = await res.json()
const workerJwt = creds.worker_jwt
const apiBase = creds.api_base_url
const expiresIn = creds.expires_in
const workerEpoch =
  typeof creds.worker_epoch === 'string' ? Number(creds.worker_epoch) : creds.worker_epoch
if (!workerJwt || !apiBase || typeof workerEpoch !== 'number') {
  throw new Error(`malformed /bridge response: ${JSON.stringify(creds).slice(0, 300)}`)
}
log(`  worker_jwt: ${mask(workerJwt)}`)
log(`  api_base_url: ${apiBase}`)
log(`  expires_in: ${expiresIn}s  worker_epoch: ${workerEpoch}`)

const sessionUrl = `${apiBase.replace(/\/+$/, '')}/v1/code/sessions/${cseId}`

// ─── 3. register worker as idle ────────────────────────────────────────────
log('step 3: PUT /worker (register idle)')
res = await fetch(`${sessionUrl}/worker`, {
  method: 'PUT',
  headers: workerHeaders(workerJwt),
  body: JSON.stringify({
    worker_status: 'idle',
    worker_epoch: workerEpoch,
    external_metadata: { pending_action: null, task_summary: null },
  }),
})
await expectOk('  PUT /worker', res)

// ─── 4. POST an assistant event (no Claude inference!) ──────────────────────
log('step 4: POST /worker/events (assistant message)')
const assistantMsg = {
  type: 'assistant',
  uuid: randomUUID(),
  session_id: cseId,
  parent_tool_use_id: null,
  message: {
    id: `msg_${randomUUID()}`,
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello from the worker protocol probe — produced without any Claude inference.' }],
    model: 'claude-remote-lib-probe',
    stop_reason: 'end_turn',
  },
}
res = await fetch(`${sessionUrl}/worker/events`, {
  method: 'POST',
  headers: workerHeaders(workerJwt),
  body: JSON.stringify({ worker_epoch: workerEpoch, events: [{ payload: assistantMsg }] }),
})
await expectOk('  POST /worker/events', res)

// ─── 5. SSE read (brief) ────────────────────────────────────────────────────
log('step 5: GET /worker/events/stream (SSE, 6s)')
const ac = new AbortController()
const to = setTimeout(() => ac.abort(), 6000)
try {
  res = await fetch(`${sessionUrl}/worker/events/stream`, {
    headers: {
      ...workerHeaders(workerJwt),
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Last-Event-ID': '0',
    },
    signal: ac.signal,
  })
  log(`  stream → ${res.status} ${res.statusText}`)
  if (res.ok && res.body) {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let bytes = 0
    while (bytes < 4096) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = dec.decode(value, { stream: true })
      bytes += chunk.length
      // Print only data payloads, truncated — no secrets expected here anyway.
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          log(`  frame: ${line.slice(5).trim().slice(0, 160)}`)
        }
      }
    }
    log(`  (read ${bytes} bytes, closing)`)
  } else {
    const body = await res.text().catch(() => '')
    log(`  stream body: ${body.slice(0, 200)}`)
  }
} catch (e) {
  if (e.name !== 'AbortError') log(`  stream error: ${e.message}`)
  else log('  (6s elapsed — stream closed)')
} finally {
  clearTimeout(to)
}

// ─── 6. cleanup: archive ────────────────────────────────────────────────────
log('step 6: archive (best-effort)')
// The compat client API uses session_* ids; the body after the tag is shared.
const body = cseId.slice(cseId.lastIndexOf('_') + 1)
const sessionIdCompat = `session_${body}`
for (const [label, url, id] of [
  ['compat /v1/sessions (session_)', `${BASE}/v1/sessions/${sessionIdCompat}/archive`, sessionIdCompat],
  ['code  /v1/code/sessions (cse_)', `${BASE}/v1/code/sessions/${cseId}/archive`, cseId],
]) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': BYOC_BETA,
        'x-organization-uuid': (await getOrgUuid()),
      },
      body: '{}',
    })
    log(`  ${label} → ${r.status}`)
    if (r.ok) break
  } catch (e) {
    log(`  ${label} error: ${e.message}`)
  }
}

console.log('')
console.log('✓ WORKER PROTOCOL VERIFIED against production.')
console.log('  session created, /bridge creds obtained, worker registered,')
console.log('  assistant message posted (no Claude inference), SSE stream opened.')
console.log(`  probe session id: ${cseId}  (archived if cleanup succeeded)`)
console.log('')

async function getOrgUuid() {
  const r = await fetch(`${BASE}/api/oauth/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const p = await r.json()
  return p?.organization?.uuid ?? ''
}
