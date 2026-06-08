/**
 * LCspace — Input Validation & Sanitization
 * Blocks XSS, injection attacks, and invalid data types.
 */

// ── Sanitization ─────────────────────────────────────────────

/** Strip control chars, HTML tags, and dangerous sequences to prevent XSS/injection */
export function sanitizeText(value, maxLength = 500) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // C0 control characters
    .replace(/[<>'"]/g, '')                              // HTML/attr injection
    .replace(/javascript:/gi, '')                        // JS protocol
    .replace(/on\w+\s*=/gi, '')                          // inline event handlers
    .trim()
    .slice(0, maxLength)
}

/** Strip everything except letters, spaces, hyphens, apostrophes for names */
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

/** Normalise a full email address — lowercase, strip illegal chars, enforce RFC length */
export function sanitizeEmail(value) {
  if (typeof value !== 'string') return ''
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9@._+\-]/g, '')
    .slice(0, 254) // RFC 5321 maximum
}

// ── Type / format validators ──────────────────────────────────

/** Validate student ID format: YYYY-NNNNN */
export function isValidStudentId(value) {
  return /^\d{4}-\d{4,6}$/.test(value)
}

/** Full USPF email must end with @uspf.edu.ph */
export function isValidUspfEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@uspf\.edu\.ph$/.test(email)
}

/** Basic email format check (simplified RFC 5322) */
export function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  )
}

/**
 * Password rules: 8–128 chars, ≥1 uppercase, ≥1 lowercase, ≥1 digit.
 * Max 128 prevents DoS via huge bcrypt/hash input.
 */
export function isValidPassword(password) {
  if (typeof password !== 'string') return false
  if (password.length < 8 || password.length > 128) return false
  return /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)
}

/** Time slot format: HH:MM AM/PM – HH:MM AM/PM */
export function isValidTimeSlot(value) {
  return /^\d{1,2}:\d{2}\s?(AM|PM)\s?[-–]\s?\d{1,2}:\d{2}\s?(AM|PM)$/i.test(value)
}

// ── Batch field validator ─────────────────────────────────────
/**
 * Validate a plain object of fields against a schema.
 * Schema entry: { required, type, maxLength, pattern, message, custom }
 * Returns: { valid: boolean, errors: { fieldName: string } }
 */
export function validateFields(data, schema) {
  const errors = {}

  for (const [field, rules] of Object.entries(schema)) {
    const raw = data[field]
    const value = typeof raw === 'string' ? raw.trim() : raw

    if (rules.required && (value === undefined || value === null || value === '')) {
      errors[field] = rules.message || `${field} is required.`
      continue
    }
    if (value === '' || value === undefined) continue

    if (rules.type === 'string' && typeof value !== 'string') {
      errors[field] = `${field} must be text.`
    }
    if (rules.type === 'number' && (typeof value !== 'number' || isNaN(value))) {
      errors[field] = `${field} must be a number.`
    }
    if (rules.maxLength && String(value).length > rules.maxLength) {
      errors[field] = `${field} is too long (max ${rules.maxLength} characters).`
    }
    if (rules.pattern && !rules.pattern.test(String(value))) {
      errors[field] = rules.message || `${field} format is invalid.`
    }
    if (rules.custom) {
      const msg = rules.custom(value)
      if (msg) errors[field] = msg
    }
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

// ── Common schemas ────────────────────────────────────────────
export const REGISTER_SCHEMA = {
  studentId: {
    required: true, type: 'string', maxLength: 12,
    custom: v => isValidStudentId(v) ? null : 'Student ID must be in YYYY-NNNNN format.',
  },
  name: {
    required: true, type: 'string', maxLength: 100,
    pattern: /^[a-zA-ZÀ-ÖØ-öø-ÿ\s\-'.]+$/,
    message: 'Full name contains invalid characters.',
  },
  department: { required: true, type: 'string', maxLength: 100 },
  password: {
    required: true,
    custom: v => isValidPassword(v)
      ? null
      : 'Password must be 8–128 characters with uppercase, lowercase, and a number.',
  },
}

export const LOGIN_SCHEMA = {
  email: {
    required: true,
    custom: v => isValidEmail(v) ? null : 'Enter a valid email address.',
  },
  password: {
    required: true,
    custom: v => (typeof v === 'string' && v.length >= 1 && v.length <= 128)
      ? null
      : 'Password is required and must not exceed 128 characters.',
  },
}

export const BOOKING_SCHEMA = {
  room_name: { required: true, type: 'string', maxLength: 100 },
  purpose:   { required: true, type: 'string', maxLength: 300 },
  time: {
    required: true,
    custom: v => isValidTimeSlot(v) ? null : 'Invalid time slot format.',
  },
}
