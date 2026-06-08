/**
 * LCspace Mobile — Client-Side Rate Limiter
 * Sliding window stored in AsyncStorage so limits survive app restarts.
 * Note: this is a UX guard. Firebase Auth and Firestore rules enforce
 * server-side limits independently.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const LIMITS = {
  login:    { max: 5,  windowMs: 15 * 60 * 1000 }, // 5 per 15 min
  register: { max: 3,  windowMs: 60 * 60 * 1000 }, // 3 per hour
  booking:  { max: 10, windowMs: 60 * 60 * 1000 }, // 10 per hour
  recovery: { max: 5,  windowMs: 15 * 60 * 1000 }, // 5 per 15 min
  message:  { max: 10, windowMs: 60 * 60 * 1000 }, // 10 per hour
}

const PREFIX = 'lcrl_'

async function readRecord(action) {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + action)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function writeRecord(action, record) {
  try {
    await AsyncStorage.setItem(PREFIX + action, JSON.stringify(record))
  } catch { /* storage full — fail open */ }
}

async function removeRecord(action) {
  try { await AsyncStorage.removeItem(PREFIX + action) } catch { /* ignore */ }
}

/**
 * Check and record an action attempt.
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
 */
export async function checkRateLimit(action) {
  const limit = LIMITS[action]
  if (!limit) return { allowed: true, remaining: 99, retryAfterMs: 0 }

  const now = Date.now()
  let record = await readRecord(action)

  if (!record || now - record.windowStart > limit.windowMs) {
    record = { windowStart: now, count: 0 }
  }

  if (record.count >= limit.max) {
    const retryAfterMs = limit.windowMs - (now - record.windowStart)
    return { allowed: false, remaining: 0, retryAfterMs }
  }

  record.count += 1
  await writeRecord(action, record)

  return { allowed: true, remaining: limit.max - record.count, retryAfterMs: 0 }
}

export async function resetRateLimit(action) {
  await removeRecord(action)
}

export function formatRetryAfter(ms) {
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} seconds`
  const minutes = Math.ceil(ms / 60000)
  return minutes === 1 ? 'about 1 minute' : `${minutes} minutes`
}
