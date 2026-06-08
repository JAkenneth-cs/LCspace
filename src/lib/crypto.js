/** SHA-256 via Web Crypto API — returns lowercase hex string */
export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Collision-resistant booking/waitlist ID — prefix + timestamp base-36 + 4-char random */
export function genId(prefix) {
  const ts  = Date.now().toString(36).toUpperCase().slice(-5)
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}-${ts}${rnd}`
}
