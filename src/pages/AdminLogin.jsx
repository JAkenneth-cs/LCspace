import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { adminAuth as auth, adminDb as db } from '../lib/firebase'
import { Mail, Lock, Eye, EyeOff, AlertCircle, Shield, ShieldCheck } from 'lucide-react'
import { checkRateLimit, resetRateLimit, formatRetryAfter } from '../lib/rateLimit'

const DEV_MODE = false

export default function AdminLogin() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    // ── Rate limiting ─────────────────────────────────────────
    const rl = checkRateLimit('admin')
    if (!rl.allowed) {
      setError(`Too many attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`)
      return
    }

    setLoading(true)

    if (DEV_MODE) {
      sessionStorage.setItem('admin_user', JSON.stringify({
        id: 'admin-bypass-001',
        name: 'Prof. Julian Vane',
        role: 'admin',
      }))
      setTimeout(() => navigate('/admin'), 400)
      return
    }

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      const snap = await getDoc(doc(db, 'users', cred.user.uid))
      const role = snap.exists() ? snap.data().role : null
      if (!['admin', 'staff'].includes(role)) {
        await auth.currentUser.delete()
        throw new Error('Access denied. Admin or staff credentials required.')
      }
      sessionStorage.setItem('admin_user', JSON.stringify({
        id: cred.user.uid,
        name: snap.data().name || email,
        role,
      }))
      navigate('/admin')
      resetRateLimit('admin')
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const FIELD_CLASS = 'w-full py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-[#262367] focus:ring-1 focus:ring-[#262367] transition'

  return (
    <div className="min-h-screen flex bg-gray-100">
      <div className="m-auto w-full max-w-4xl">
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden flex shadow-sm">

          {/* ── Left branding ── */}
          <div className="hidden lg:flex w-[45%] bg-[#262367] flex-col p-12">

            <div className="flex items-center gap-3 mb-16">
              <img
                src="/assets/img/Schoollogo.png"
                alt="USPF"
                className="w-9 h-9 object-contain"
                onError={e => { e.target.style.display = 'none' }}
              />
              <span className="text-white font-bold text-base tracking-tight">
                LC<span className="text-[#F5C900]">space</span>
              </span>
            </div>

            <h1 className="text-2xl font-bold text-white leading-snug mb-3">
              Administration Portal
            </h1>
            <p className="text-white/50 text-sm leading-relaxed mb-auto max-w-xs">
              Restricted access for USPF administrators and staff. Manage student bookings, approve accounts, and oversee campus facilities.
            </p>

            {/* Roles */}
            <div className="space-y-2 mb-10">
              {['Administrator', 'Staff'].map(role => (
                <div key={role} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#F5C900] flex-shrink-0" />
                  <span className="text-white/70 text-xs">{role} access</span>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F5C900]/10 border border-[#F5C900]/20">
              <Shield className="w-3.5 h-3.5 text-[#F5C900] flex-shrink-0" />
              <span className="text-[#F5C900] text-xs font-medium">Secure institutional access</span>
            </div>
          </div>

          {/* ── Right form ── */}
          <div className="flex-1 flex items-center justify-center p-10 lg:p-12">
            <div className="w-full max-w-sm">

              {/* Mobile logo */}
              <div className="lg:hidden flex items-center gap-2 mb-8">
                <img src="/assets/img/Schoollogo.png" alt="USPF" className="w-7 h-7 object-contain"
                  onError={e => { e.target.style.display = 'none' }} />
                <span className="font-bold text-[#262367]">LC<span className="text-[#F5C900]">space</span></span>
              </div>

              <div className="mb-7">
                <h2 className="text-xl font-semibold text-gray-900">Staff sign in</h2>
                <p className="text-gray-500 text-sm mt-1">Authorized personnel only.</p>
              </div>

              {error && (
                <div className="mb-5 flex items-start gap-2.5 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="admin-email" className="block text-sm font-medium text-gray-700 mb-1.5">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                    <input
                      id="admin-email"
                      name="email"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      placeholder="admin@uspf.edu.ph"
                      autoComplete="username"
                      className={`${FIELD_CLASS} pl-9 pr-3`}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="admin-password" className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                    <input
                      id="admin-password"
                      name="password"
                      type={showPass ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className={`${FIELD_CLASS} pl-9 pr-10`}
                    />
                    <button type="button" onClick={() => setShowPass(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition">
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-[#262367] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#35318c] transition disabled:opacity-50 flex items-center justify-center gap-2 mt-1"
                >
                  {loading
                    ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg><span>Signing in…</span></>
                    : 'Sign in to admin panel'}
                </button>
              </form>

              <p className="mt-8 text-xs text-center text-gray-400">
                This system is for authorized USPF personnel only.<br />
                Unauthorized access is prohibited.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
