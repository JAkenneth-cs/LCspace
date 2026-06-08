/**
 * LCspace Mobile — Input Validation & Sanitization
 * Mirrors the website's validation helpers so user input is sanitized
 * before it ever reaches Firestore.
 */

// ── Sanitization ─────────────────────────────────────────────

/** Strip control chars, HTML tags, and dangerous sequences */
export function sanitizeText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[<>'"]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
    .slice(0, 500)
}

/** Strip everything except letters, spaces, hyphens, apostrophes */
export function sanitizeName(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ\s\-'.]/g, '')
    .trim()
    .slice(0, 100)
}

/** Normalise a USPF email prefix (left side of @) */
export function sanitizeEmailPrefix(value) {
  if (typeof value !== 'string') return ''
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64)
}

/** Normalise a full email address */
export function sanitizeEmail(value) {
  if (typeof value !== 'string') return ''
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9@._+\-]/g, '')
    .slice(0, 254)
}

// ── Type / format validators ──────────────────────────────────

export function isValidStudentId(value) {
  return /^\d{4}-\d{4,6}$/.test(value)
}

export function isValidUspfEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@uspf\.edu\.ph$/.test(email)
}

export function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  )
}

/** Password rules: 8–128 chars, ≥1 uppercase, ≥1 lowercase, ≥1 digit */
export function isValidPassword(password) {
  if (typeof password !== 'string') return false
  if (password.length < 8 || password.length > 128) return false
  return /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)
}
