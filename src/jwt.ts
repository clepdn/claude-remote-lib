/**
 * Minimal JWT helpers — decode payload/expiry WITHOUT verifying the signature.
 * The worker JWT returned by POST /v1/code/sessions/{id}/bridge is opaque; we
 * only need its `exp` to schedule a refresh before it expires.
 */

export function decodeJwtPayload(token: string): unknown | null {
  // Session-ingress JWTs may carry an `sk-ant-si-` prefix; strip it.
  const jwt = token.startsWith('sk-ant-si-')
    ? token.slice('sk-ant-si-'.length)
    : token
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    )
  } catch {
    return null
  }
}

/** Decode the `exp` claim (Unix seconds), or null if unparseable. */
export function decodeJwtExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token)
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'exp' in payload &&
    typeof (payload as { exp?: unknown }).exp === 'number'
  ) {
    return (payload as { exp: number }).exp
  }
  return null
}
