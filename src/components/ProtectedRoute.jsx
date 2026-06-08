import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'

/**
 * ProtectedRoute — Authorization guard.
 * Verifies the user is:
 *   1. Authenticated via Firebase Auth
 *   2. Has an ACTIVE account status in Firestore (not pending/suspended/rejected)
 *
 * The dev_user sessionStorage bypass has been removed for production safety.
 */
export default function ProtectedRoute({ children, requireRole }) {
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) { setStatus('redirect'); return }

      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (!snap.exists()) { setStatus('redirect'); return }

        const data = snap.data()

        // ── Authorization: check account status ───────────────
        if (data.status !== 'ACTIVE') { setStatus('suspended'); return }

        // ── Authorization: role check (optional) ──────────────
        if (requireRole && data.role !== requireRole && data.role !== 'admin') {
          setStatus('forbidden'); return
        }

        setStatus('ok')
      } catch {
        // Firestore read failed (network / rules) — redirect safely
        setStatus('redirect')
      }
    })
    return unsub
  }, [requireRole])

  if (status === 'loading') return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50">
      <div className="w-8 h-8 border-4 border-[#262367] border-t-[#F5C900] rounded-full animate-spin" />
      <p className="text-sm text-gray-500 font-medium">Loading your account…</p>
    </div>
  )

  if (status === 'suspended') return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full bg-white rounded-2xl border border-gray-200 p-8 text-center shadow-sm">
        <div className="w-12 h-12 bg-orange-50 rounded-xl flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">Account restricted</h2>
        <p className="text-gray-500 text-sm mb-5">
          Your account is pending approval or has been suspended. Please contact the LCspace administrator.
        </p>
        <button
          onClick={() => { auth.signOut(); window.location.href = '/' }}
          className="w-full py-2.5 bg-[#262367] text-white rounded-xl text-sm font-semibold hover:bg-[#35318c] transition"
        >
          Back to sign in
        </button>
      </div>
    </div>
  )

  if (status === 'forbidden') return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full bg-white rounded-2xl border border-gray-200 p-8 text-center shadow-sm">
        <div className="w-12 h-12 bg-red-50 rounded-xl flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M18.364 5.636l-12.728 12.728M5.636 5.636l12.728 12.728" />
          </svg>
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">Access denied</h2>
        <p className="text-gray-500 text-sm mb-5">You don't have permission to view this page.</p>
        <button
          onClick={() => window.history.back()}
          className="w-full py-2.5 bg-[#262367] text-white rounded-xl text-sm font-semibold hover:bg-[#35318c] transition"
        >
          Go back
        </button>
      </div>
    </div>
  )

  if (status === 'redirect') return <Navigate to="/" replace />
  return children
}
