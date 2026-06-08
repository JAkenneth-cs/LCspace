/**
 * LCspace — Client-Side Rate Limiter
 * Sliding-window stored in localStorage so limits survive tab refreshes
 * and apply consistently across multiple open tabs.
 * Note: client-side limits are a UX guard — Firebase Auth also enforces
 * server-side limits on auth endpoints independently.
 */

const LIMITS = {
  login: { max: 5, windowMs: 15 * 60 * 1000 }, // 5 per 15 min
  register: { max: 3, windowMs: 3 * 60 * 1000 },    // 3 per 3 minutes (reduced from 60 min)
  booking: { max: 10, windowMs: 3 * 60 * 1000 },  // 10 per 3 minutes (reduced from 60 min)
  admin: { max: 10, windowMs: 10 * 60 * 1000 }, // 10 per 10 min
  recovery: { max: 5, windowMs: 15 * 60 * 1000 }, // 5 per 15 min
  helpticket: { max: 5, windowMs: 60 * 60 * 1000 }, // 5 per hour
  waitlist: { max: 10, windowMs: 60 * 60 * 1000 }, // 10 per hour
  message: { max: 10, windowMs: 60 * 60 * 1000 }, // 10 per hour
}

const PREFIX = 'lcrl_'

function readRecord(action) {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + action) || 'null')
  } catch {
    return null
  }
}

function writeRecord(action, record) {
  try {
    localStorage.setItem(PREFIX + action, JSON.stringify(record))
  } catch { /* storage full — fail open */ }
}

function removeRecord(action) {
  try {
    localStorage.removeItem(PREFIX + action)
  } catch { /* ignore */ }
}

/**
 * Check and record an action attempt.
 * @param {keyof typeof LIMITS} action
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
export function checkRateLimit(action) {
  const limit = LIMITS[action]
  if (!limit) return { allowed: true, remaining: 99, retryAfterMs: 0 }

  const now = Date.now()
  let record = readRecord(action)

  if (!record || now - record.windowStart > limit.windowMs) {
    record = { windowStart: now, count: 0 }
  }

  if (record.count >= limit.max) {
    const retryAfterMs = limit.windowMs - (now - record.windowStart)
    return { allowed: false, remaining: 0, retryAfterMs }
  }

  record.count += 1
  writeRecord(action, record)

  return { allowed: true, remaining: limit.max - record.count, retryAfterMs: 0 }
}

/** Reset the rate limit counter for an action (call after successful operation) */
export function resetRateLimit(action)   {
  removeRecord(action)
}

/** Human-readable countdown string from milliseconds */
export function formatRetryAfter(ms) {
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} seconds`
  const minutes = Math.ceil(ms / 60000)
  return minutes === 1 ? 'about 1 minute' : `${minutes} minutes`
}
