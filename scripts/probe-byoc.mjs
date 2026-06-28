#!/usr/bin/env node
/**
 * Probe the Claude BYOC / sessions API using the OAuth token in
 * ~/.pi/agent/auth.json (shape: { anthropic: { access, refresh } }).
 *
 * SECURITY: this script reads the token file at runtime and never prints
 * the token, refresh token, or file contents. Only non-secret outcomes
 * (status codes, org uuid, session count + titles) are logged.
 *
 *   node scripts/probe-byoc.mjs
 *
 * It will:
 *   1. Load the access + refresh tokens (no echo).
 *   2. GET /api/oauth/profile  → resolve organization uuid.
 *      (refreshes the access token first if the profile call 401s.)
 *   3. GET /v1/sessions  (the ccr-byoc-2025-07-29 sessions API) → list sessions.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://api.anthropic.com'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
// Public PKCE client id used by the Claude CLI (no secret required).
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const BYOC_BETA = 'ccr-byoc-2025-07-29'
const AUTH_FILE = join(homedir(), '.pi', 'agent', 'auth.json')

function log(msg) {
  console.error(`[probe] ${msg}`)
}

function mask(s) {
  if (!s) return '<none>'
  return `${s.slice(0, 4)}…${s.slice(-3)} (${s.length} chars)`
}

// ─── 1. Load tokens (never printed) ────────────────────────────────────────
let accessToken
let refreshToken
try {
  const raw = readFileSync(AUTH_FILE, 'utf8')
  const json = JSON.parse(raw)
  accessToken = json?.anthropic?.access
  refreshToken = json?.anthropic?.refresh
} catch (e) {
  console.error(`[probe] could not read ${AUTH_FILE}: ${e.message}`)
  process.exit(1)
}
if (!accessToken) {
  console.error('[probe] no anthropic.access token in file')
  process.exit(1)
}
log(`loaded access token: ${mask(accessToken)}`)
log(`refresh token present: ${Boolean(refreshToken)}`)

// ─── helpers ───────────────────────────────────────────────────────────────
async function getProfile(token) {
  const res = await fetch(`${BASE}/api/oauth/profile`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  return res
}

async function refreshAccessToken(rt) {
  log('refreshing access token…')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: CLIENT_ID,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`refresh failed ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.access_token
}

async function listSessions(token, orgUuid) {
  const res = await fetch(`${BASE}/v1/sessions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BYOC_BETA,
      'x-organization-uuid': orgUuid,
    },
  })
  return res
}

// ─── 2. Resolve org uuid (refresh if 401) ──────────────────────────────────
let profileRes = await getProfile(accessToken)
log(`GET /api/oauth/profile → ${profileRes.status}`)
if (profileRes.status === 401 && refreshToken) {
  accessToken = await refreshAccessToken(refreshToken)
  log(`refreshed access token: ${mask(accessToken)}`)
  profileRes = await getProfile(accessToken)
  log(`GET /api/oauth/profile (retry) → ${profileRes.status}`)
}
if (!profileRes.ok) {
  const body = await profileRes.text().catch(() => '')
  console.error(`[probe] profile failed: ${profileRes.status} ${body.slice(0, 200)}`)
  process.exit(1)
}

const profile = await profileRes.json()
const orgUuid = profile?.organization?.uuid
if (!orgUuid) {
  console.error('[probe] no organization.uuid in profile response')
  console.error(`[probe] profile keys: ${Object.keys(profile).join(', ')}`)
  process.exit(1)
}
log(`organization uuid: ${orgUuid}`)

// ─── 3. Hit the BYOC sessions API ───────────────────────────────────────────
const sessionsRes = await listSessions(accessToken, orgUuid)
log(`GET /v1/sessions → ${sessionsRes.status}`)
if (!sessionsRes.ok) {
  const body = await sessionsRes.text().catch(() => '')
  console.error(`[probe] list sessions failed: ${sessionsRes.status} ${body.slice(0, 300)}`)
  process.exit(1)
}

const data = await sessionsRes.json()
const sessions = Array.isArray(data?.data) ? data.data : []
console.log('')
console.log(`✓ BYOC sessions API authenticated successfully.`)
console.log(`  sessions: ${sessions.length}`)
for (const s of sessions.slice(0, 10)) {
  console.log(`   - ${s.id}  [${s.session_status ?? '??'}]  ${s.title ?? 'Untitled'}`)
}
console.log('')
