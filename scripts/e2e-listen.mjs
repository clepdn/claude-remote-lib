#!/usr/bin/env node
/**
 * End-to-end interactive test of the worker protocol.
 *
 * Creates a live session, holds the SSE stream open, and replies to anything
 * you type in the Claude app — WITHOUT any Claude inference. This closes the
 * loop: claude.ai → SSE → here → assistant reply → claude.ai.
 *
 *   node scripts/e2e-listen.mjs
 *
 * Then: open the Claude app / claude.ai/code, find the session titled
 * "claude-remote-lib E2E", and type a message. You should see a reply
 * come back that is clearly produced by this script (an echo), not Claude.
 *
 * Ctrl+C to stop (archives the session).
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

function log(m) { console.error(`[e2e] ${m}`) }
function out(m) { console.log(m) }
function mask(s) { return s ? `${s.slice(0, 6)}…${s.slice(-3)}` : '<none>' }

// ─── tokens ───────────────────────────────────────────────────────────────
let accessToken, refreshToken
try {
  const j = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  accessToken = j?.anthropic?.access
  refreshToken = j?.anthropic?.refresh
} catch (e) {
  console.error(`[e2e] cannot read auth file: ${e.message}`); process.exit(1)
}
if (!accessToken) { console.error('[e2e] no access token'); process.exit(1) }

async function refreshIfNeeded() {
  const r = await fetch(`${BASE}/api/oauth/profile`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (r.status !== 401) return
  if (!refreshToken) throw new Error('access 401, no refresh token')
  log('refreshing access token…')
  const rr = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
  })
  if (!rr.ok) throw new Error(`refresh failed ${rr.status}`)
  accessToken = (await rr.json()).access_token
  log(`refreshed: ${mask(accessToken)}`)
}
function oauthH() { return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION } }
function workerH(jwt) { return { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION } }

// ─── 1. create session + 2. /bridge creds ─────────────────────────────────
await refreshIfNeeded()
log('creating session…')
let res = await fetch(`${BASE}/v1/code/sessions`, {
  method: 'POST', headers: oauthH(),
  body: JSON.stringify({ title: 'claude-remote-lib E2E — type here!', bridge: {} }),
})
if (!res.ok) throw new Error(`create failed ${res.status}: ${await res.text().catch(() => '')}`)
const cseId = (await res.json()).session.id
log(`session: ${cseId}`)

res = await fetch(`${BASE}/v1/code/sessions/${cseId}/bridge`, { method: 'POST', headers: oauthH(), body: '{}' })
if (!res.ok) throw new Error(`/bridge failed ${res.status}`)
const creds = await res.json()
const workerJwt = creds.worker_jwt
const sessionUrl = `${creds.api_base_url.replace(/\/+$/, '')}/v1/code/sessions/${cseId}`
const epoch = typeof creds.worker_epoch === 'string' ? Number(creds.worker_epoch) : creds.worker_epoch
log(`worker_epoch=${epoch}  expires_in=${creds.expires_in}s  worker_jwt=${mask(workerJwt)}`)

// ─── 3. register idle ─────────────────────────────────────────────────────
res = await fetch(`${sessionUrl}/worker`, {
  method: 'PUT', headers: workerH(workerJwt),
  body: JSON.stringify({ worker_status: 'idle', worker_epoch: epoch, external_metadata: { pending_action: null, task_summary: null } }),
})
log(`PUT /worker (idle) → ${res.status}`)

// ─── helpers: write event, ack delivery, archive ───────────────────────────
async function writeEvent(payload) {
  const r = await fetch(`${sessionUrl}/worker/events`, {
    method: 'POST', headers: workerH(workerJwt),
    body: JSON.stringify({ worker_epoch: epoch, events: [{ payload: { ...payload, uuid: payload.uuid ?? randomUUID(), session_id: cseId } }] }),
  })
  return r.status
}
async function ackDelivery(eventId, status = 'processed') {
  await fetch(`${sessionUrl}/worker/events/delivery`, {
    method: 'POST', headers: workerH(workerJwt),
    body: JSON.stringify({ worker_epoch: epoch, updates: [{ event_id: eventId, status }] }),
  }).catch(() => {})
}
async function reportRunning() {
  await fetch(`${sessionUrl}/worker`, {
    method: 'PUT', headers: workerH(workerJwt),
    body: JSON.stringify({ worker_status: 'running', worker_epoch: epoch, external_metadata: {} }),
  }).catch(() => {})
}
async function archive() {
  const body = cseId.slice(cseId.lastIndexOf('_') + 1)
  const sid = `session_${body}`
  const org = (await (await fetch(`${BASE}/api/oauth/profile`, { headers: { Authorization: `Bearer ${accessToken}` } })).json())?.organization?.uuid
  for (const url of [`${BASE}/v1/sessions/${sid}/archive`, `${BASE}/v1/code/sessions/${cseId}/archive`]) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': BYOC_BETA, 'x-organization-uuid': org }, body: '{}' })
      log(`archive ${url.split('/v1/')[1]} → ${r.status}`)
      if (r.ok) break
    } catch (e) { log(`archive error: ${e.message}`) }
  }
}

// ─── reply to a user message ──────────────────────────────────────────────
let turn = 0
async function replyTo(userText) {
  turn++
  const text = `🔁 echo via claude-remote-lib (no Claude inference) — turn ${turn}, you said: "${userText}"`
  const status = await writeEvent({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`, role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-remote-lib-probe', stop_reason: 'end_turn',
    },
  })
  out(`  ↳ replied (POST /worker/events → ${status}): ${text}`)
}

// ─── control_request responder ───────────────────────────────────────────
async function respondControl(req) {
  const rid = req.request_id
  let response
  switch (req.request?.subtype) {
    case 'initialize':
      response = { type: 'control_response', response: { subtype: 'success', request_id: rid, response: { commands: [], output_style: 'normal', available_output_styles: ['normal'], models: [], account: {}, pid: process.pid } } }
      break
    case 'set_model':
      log(`  control: set_model → ${req.request.model}`)
      response = { type: 'control_response', response: { subtype: 'success', request_id: rid } }
      break
    case 'set_max_thinking_tokens':
    case 'interrupt':
    case 'set_permission_mode':
      response = { type: 'control_response', response: { subtype: 'success', request_id: rid } }
      break
    case 'can_use_tool':
      // We have no tools — deny so the server doesn't hang.
      response = { type: 'control_response', response: { subtype: 'success', request_id: rid, response: { behavior: 'deny', message: 'no tools in probe' } } }
      break
    default:
      response = { type: 'control_response', response: { subtype: 'error', request_id: rid, error: `probe does not handle ${req.request?.subtype}` } }
  }
  const status = await writeEvent(response)
  log(`  control_response for ${req.request?.subtype} → ${status}`)
}

// ─── SSE listen loop ──────────────────────────────────────────────────────
function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('')
  return JSON.stringify(content)
}

let lastSeq = 0
let stopping = false

async function listenOnce() {
  const url = new URL(`${sessionUrl}/worker/events/stream`)
  if (lastSeq > 0) url.searchParams.set('from_sequence_num', String(lastSeq))
  log(`opening SSE stream…${lastSeq ? ` (from seq ${lastSeq})` : ''}`)
  const res = await fetch(url, {
    headers: { ...workerH(workerJwt), Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': String(lastSeq) },
  })
  log(`SSE → ${res.status} ${res.statusText}`)
  if (!res.ok || !res.body) { log(`stream not ok: ${await res.text().catch(() => '')}`); return false }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (!stopping) {
    const { done, value } = await reader.read()
    if (done) { log('stream ended'); return true } // reconnect
    buf += dec.decode(value, { stream: true })
    let sep
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep); buf = buf.slice(sep + 2)
      const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
      if (dataLines.length === 0) continue
      let env
      try { env = JSON.parse(dataLines.join('\n')) } catch { continue }
      if (typeof env.sequence_num === 'number') lastSeq = Math.max(lastSeq, env.sequence_num)
      if (env.event_id) void ackDelivery(env.event_id)
      const p = env.payload
      if (!p || typeof p !== 'object') continue
      if (p.type === 'control_request') { await respondControl(p) }
      else if (p.type === 'user') {
        const text = extractText(p.message?.content)
        out(`\n✉ RECEIVED user message: "${text}"`)
        await reportRunning()
        await replyTo(text)
      } else {
        log(`(inbound ${p.type}${p.subtype ? `/${p.subtype}` : ''})`)
      }
    }
  }
  return false
}

// ─── run ─────────────────────────────────────────────────────────────────
out('')
out('════════════════════════════════════════════════════════════════')
out('  Session is LIVE. Open the Claude app / claude.ai/code,')
out('  find the session titled:')
out('    "claude-remote-lib E2E — type here!"')
out(`  (id: ${cseId})`)
out('  and type a message. Replies are echoed by this script — no Claude.')
out('  Ctrl+C to stop.')
out('════════════════════════════════════════════════════════════════')
out('')

while (!stopping) {
  try {
    const ended = await listenOnce()
    if (!ended) await new Promise(r => setTimeout(r, 1000))
  } catch (e) {
    if (stopping) break
    log(`listen error: ${e.message} — reconnecting in 2s`)
    await new Promise(r => setTimeout(r, 2000))
  }
}

process.on('SIGINT', async () => {
  stopping = true
  out('\n[e2e] stopping — archiving session…')
  try { await archive() } catch {}
  process.exit(0)
})
