import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createUserWithEmailAndPassword, deleteUser } from 'firebase/auth'
import { collection, query, where, getDocs, doc, setDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import {
  CheckCircle2, AlertCircle, Eye, EyeOff,
  IdCard, User, AtSign, Lock, Building2, ArrowRight,
} from 'lucide-react'
import { checkRateLimit, formatRetryAfter } from '../lib/rateLimit'
import {
  sanitizeName, sanitizeEmailPrefix, sanitizeText,
  isValidStudentId, isValidPassword,
} from '../lib/validation'

function mapRegisterError(err) {
  const code = err?.code || ''
  if (code === 'auth/email-already-in-use') return 'This email is already registered. Try signing in instead.'
  if (code === 'auth/invalid-email') return 'The email address is not valid.'
  if (code === 'auth/weak-password') return 'Password is too weak. Use at least 8 characters with mixed case and a number.'
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.'
  if (code === 'auth/too-many-requests') return 'Too many requests. Please wait a moment before trying again.'
  if (code === 'auth/operation-not-allowed') return 'Account creation is currently disabled. Contact the administrator.'
  // Propagate only our own known error messages; swallow raw Firebase strings
  const msg = err?.message || ''
  if (msg.startsWith('An account with this Student ID')) return msg
  return 'Registration failed. Please check your details and try again.'
}

const DEV_MODE = false

export const DEPARTMENTS = [
  'College of Computer Studies',
  'College of Engineering',
  'College of Business Administration',
  'College of Arts and Sciences',
  'College of Education',
  'College of Health and Sciences',
  'College of Criminal Justice',
  'College of Hospitality Management',
  'Senior High School',
]

export default function Register() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ studentId: '', name: '', department: '', emailPrefix: '', password: '', confirm: '' })
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const set = key => e => {
    setForm(prev => ({ ...prev, [key]: e.target.value }))
    if (fieldErrors[key]) setFieldErrors(prev => ({ ...prev, [key]: '' }))
  }

  const strength = (() => {
    const pw = form.password
    if (!pw) return 0
    let s = 0
    if (pw.length >= 8) s++
    if (/[A-Z]/.test(pw)) s++
    if (/[0-9]/.test(pw)) s++
    if (/[^A-Za-z0-9]/.test(pw)) s++
    return Math.max(1, s)
  })()
  const strengthMeta = [
    { label: '', color: 'bg-gray-200' },
    { label: 'Weak', color: 'bg-red-500' },
    { label: 'Fair', color: 'bg-orange-400' },
    { label: 'Good', color: 'bg-yellow-400' },
    { label: 'Strong', color: 'bg-emerald-500' },
  ]

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const rl = checkRateLimit('register')
    if (!rl.allowed) {
      setError(`Too many registration attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)}.`)
      return
    }

    const cleanId = form.studentId.trim()
    const cleanName = sanitizeName(form.name)
    const cleanPrefix = sanitizeEmailPrefix(form.emailPrefix)
    const cleanDept = sanitizeText(form.department)

    // Collect ALL field errors at once so every invalid field turns red
    const errs = {}
    if (!isValidStudentId(cleanId))
      errs.studentId = 'Must be in YYYY-NNNNN format (e.g. 2023-00123).'
    if (!cleanName || cleanName.length < 2)
      errs.name = 'Please enter your full name.'
    if (!cleanDept)
      errs.department = 'Please select your department.'
    if (!cleanPrefix || cleanPrefix.length < 2)
      errs.emailPrefix = 'Please enter a valid email username.'
    if (!isValidPassword(form.password))
      errs.password = 'Must be 8–128 characters with uppercase, lowercase, and a number.'
    if (form.password.length > 128)
      errs.password = 'Password must not exceed 128 characters.'
    if (form.password && form.confirm && form.password !== form.confirm)
      errs.confirm = 'Passwords do not match.'
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})

    setLoading(true)
    const email = `${cleanPrefix}@uspf.edu.ph`

    try {
      // Create auth account first so Firestore queries run authenticated
      const cred = await createUserWithEmailAndPassword(auth, email, form.password)

      // Now authenticated — check for duplicate student ID.
      // A rejected/declined account does NOT reserve the Student ID (it's hidden
      // from the admin and treated as freed) — only an active/pending one blocks.
      const existSnap = await getDocs(
        query(collection(db, 'users'), where('student_id', '==', cleanId))
      )
      const activeDup = existSnap.docs.some(d => d.data().status !== 'rejected')
      if (activeDup) {
        await deleteUser(cred.user)
        throw new Error('An account with this Student ID already exists.')
      }

      await setDoc(doc(db, 'users', cred.user.uid), {
        student_id: cleanId,
        name: cleanName,
        email,
        department: cleanDept,
        role: 'student',
        status: 'pending',
        strike_count: 0,
        created_at: serverTimestamp(),
      })

      // Store password in the admin-only `student_credentials` collection
      // (NOT in the user doc, which is publicly readable for account recovery).
      await setDoc(doc(db, 'student_credentials', cred.user.uid), {
        password: form.password,
      })

      // Send automated welcome message
      await addDoc(collection(db, 'admin_messages'), {
        subject: 'Welcome to LCspace!',
        message: `Hi ${cleanName},\n\nWelcome to LCspace — the University of Southern Philippines Foundation's collaborative learning hub!\n\nYour account has been submitted for admin review. Once approved, you'll have full access to all LCspace features.\n\n── What you can do in LCspace ──\n\n• Reserve Facility — Book a study room or Makers' Space for your group (2-hour slots, Monday–Friday, 8 AM–4 PM).\n• Cyberspace — Join a virtual collaborative session with real-time whiteboard, video, and chat. Requires a confirmed booking and check-in at the admin desk.\n• My Calendar — View all your upcoming and past reservations in one place.\n• Mail — Send messages to the admin or receive updates about your bookings.\n• Help & Support — Submit a ticket if you need assistance.\n\n── Getting started ──\n\n1. Wait for your account to be confirmed by the admin.\n2. Head to "Reserve Facility" and pick a room, date, and time slot.\n3. Once your booking is confirmed, visit the LCspace desk to check in.\n4. Access Cyberspace during your reserved time window.\n\n── House Rules ──\n\n• Arrive on time — your slot cannot be extended.\n• Leave the room clean and return all equipment.\n• Three no-shows or conduct violations result in a strike. Three strikes suspend your booking privileges.\n\nIf you have any questions, use the Help & Support tab or visit the LCspace counter directly.\n\nWe're glad to have you!\n— The LCspace Administration Team`,
        recipient_id: cleanId,
        recipient_uid: cred.user.uid,
        type: 'welcome',
        sender_uid: 'system',
        created_at: serverTimestamp(),
      })

      try { localStorage.setItem('lc-theme', 'light') } catch { }
      setSuccess(true)
      setTimeout(() => navigate('/'), 2500)
    } catch (err) {
      setError(mapRegisterError(err))
      setLoading(false)
    }
  }

  const INPUT = 'w-full h-10 rounded-xl border border-white/[0.15] bg-white/[0.07] text-sm text-white placeholder-white/35 focus:outline-none focus:bg-white/[0.12] focus:border-[#F5C900]/60 focus:ring-2 focus:ring-[#F5C900]/10 transition'
  const err = field => fieldErrors[field]
    ? 'border-red-400/60 bg-red-500/10 focus:border-red-400/60 focus:ring-red-500/10'
    : ''
  const ErrMsg = ({ field }) => fieldErrors[field]
    ? <p className="mt-1 flex items-center gap-1 text-xs text-red-400"><AlertCircle className="w-3 h-3 flex-shrink-0" />{fieldErrors[field]}</p>
    : null

  return (
    <div className="h-screen flex bg-white overflow-hidden relative">

      {/* ── Left panel ── */}
      <div className="hidden lg:flex w-[40%] bg-[#1e1b5e] flex-col relative overflow-hidden flex-shrink-0">

        {/* Decorative circles */}
        <div className="absolute -top-28 -right-28 w-96 h-96 rounded-full bg-white/[0.04] pointer-events-none" />
        <div className="absolute -bottom-20 -left-20 w-72 h-72 rounded-full bg-[#F5C900]/[0.07] pointer-events-none" />

        <div className="relative z-10 flex flex-col h-full px-10 py-10">

          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <img src="/assets/img/Schoollogo.png" alt="USPF" className="w-10 h-10 object-contain flex-shrink-0"
              onError={e => { e.target.style.display = 'none' }} />
            <div className="leading-none">
              <p className="text-white font-bold text-base tracking-tight">
                LC<span className="text-[#F5C900]">space</span>
              </p>
              <p className="text-white/30 text-[10px] mt-0.5 font-medium tracking-wider">STUDENT PORTAL</p>
            </div>
          </div>

          <h1 className="text-[2rem] font-extrabold text-white leading-[1.2] tracking-tight mb-3">
            Join the USPF<br />
            <span className="text-[#F5C900]">academic<br />community.</span>
          </h1>
          <p className="text-white/50 text-sm leading-relaxed mb-8 max-w-xs">
            Create your LCspace account to start booking study spaces, labs, and collaborative rooms.
          </p>

          {/* How it works */}
          <p className="text-white/25 text-[10px] font-bold uppercase tracking-[0.15em] mb-4">How registration works</p>
          <div className="space-y-4 mb-auto">
            {[
              { n: 1, title: 'Fill in your details', desc: 'Provide your student ID, full name, and school email.' },
              { n: 2, title: 'Wait for approval', desc: 'An admin will review and activate your account.' },
              { n: 3, title: 'Access LCspace', desc: 'Sign in and start booking campus facilities.' },
            ].map(({ n, title, desc }) => (
              <div key={n} className="flex gap-3.5 items-start">
                <div className="w-7 h-7 rounded-full bg-[#F5C900] flex items-center justify-center flex-shrink-0 shadow-md shadow-[#F5C900]/30">
                  <span className="text-[#1e1b5e] text-xs font-extrabold">{n}</span>
                </div>
                <div>
                  <p className="text-white text-sm font-semibold leading-snug">{title}</p>
                  <p className="text-white/40 text-xs mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="text-white/20 text-[11px] mt-6">University of Southern Philippines Foundation © 2025</p>
        </div>
      </div>

      {/* Mascot */}
      <img
        src="/assets/img/ChatGPT_Image_Jun_6__2026__11_25_19_PM-removebg-preview (1).png"
        alt=""
        className="hidden lg:block absolute bottom-0 z-20 pointer-events-none select-none w-72 drop-shadow-2xl"
        style={{ left: 'calc(40% - 4.6rem)' }}
      />

      {/* ── Right panel ── */}
      <div className="auth-panel flex-1 flex items-center justify-center bg-gradient-to-br from-[#0d1030] via-[#161450] to-[#0b0e1e] relative px-6 py-4 overflow-hidden">

        {/* Decorative glows */}
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[#F5C900]/[0.05] blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -left-16 w-80 h-80 rounded-full bg-[#2563eb]/[0.07] blur-3xl pointer-events-none" />

        <div className="w-full max-w-lg relative z-10">

          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-2 mb-6">
            <img src="/assets/img/Schoollogo.png" alt="USPF" className="w-7 h-7 object-contain"
              onError={e => { e.target.style.display = 'none' }} />
            <span className="font-bold text-white text-base">LC<span className="text-[#F5C900]">space</span></span>
          </div>

          {/* Glass card */}
          <div className="bg-white/[0.06] backdrop-blur-xl border border-white/[0.10] rounded-3xl shadow-2xl shadow-black/40 overflow-hidden">

            {/* Card header */}
            <div className="px-6 pt-5 pb-4 border-b border-white/[0.10]">
              <h2 className="text-xl font-bold text-white tracking-tight">Create your account</h2>
              <p className="text-white/40 text-xs mt-0.5">All fields are required unless noted.</p>
            </div>

            <div className="px-6 py-4">

              {/* Success banner */}
              {success && (
                <div className="mb-6 flex items-start gap-3 p-4 bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 rounded-xl">
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-sm">Registration submitted!</p>
                    <p className="text-emerald-300/70 text-xs mt-0.5">Your account is pending admin approval. Redirecting…</p>
                  </div>
                </div>
              )}

              {/* Error banner */}
              {error && (
                <div className="mb-6 flex items-start gap-3 p-4 bg-red-500/15 border border-red-400/30 text-red-300 rounded-xl">
                  <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <span className="text-sm leading-snug">{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-3.5">

                {/* Section: Identity */}
                <div>
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Identity</p>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label htmlFor="reg-student-id" className="block text-xs font-semibold text-white/75 mb-1">Student ID</label>
                      <div className="relative">
                        <IdCard className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${fieldErrors.studentId ? 'text-red-400' : 'text-white/40'}`} />
                        <input
                          id="reg-student-id" name="student-id"
                          type="text" value={form.studentId}
                          onChange={e => {
                            const digits = e.target.value.replace(/\D/g, '').slice(0, 10)
                            const formatted = digits.length > 4 ? digits.slice(0, 4) + '-' + digits.slice(4) : digits
                            setForm(prev => ({ ...prev, studentId: formatted }))
                            if (fieldErrors.studentId) setFieldErrors(prev => ({ ...prev, studentId: '' }))
                          }}
                          required placeholder="2023-00001"
                          autoComplete="off" inputMode="numeric" maxLength={11}
                          className={`${INPUT} pl-9 pr-3 ${err('studentId')}`}
                        />
                      </div>
                      <ErrMsg field="studentId" />
                    </div>
                    <div>
                      <label htmlFor="reg-name" className="block text-xs font-semibold text-white/75 mb-1">Full name</label>
                      <div className="relative">
                        <User className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${fieldErrors.name ? 'text-red-400' : 'text-white/40'}`} />
                        <input
                          id="reg-name" name="full-name"
                          type="text" value={form.name} onChange={set('name')}
                          required placeholder="Juan dela Cruz" autoComplete="name"
                          maxLength={100}
                          className={`${INPUT} pl-9 pr-3 ${err('name')}`}
                        />
                      </div>
                      <ErrMsg field="name" />
                    </div>
                  </div>
                </div>

                {/* Section: Academic */}
                <div>
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Academic info</p>
                  <div className="space-y-2">
                    <div>
                      <label htmlFor="reg-department" className="block text-xs font-semibold text-white/75 mb-1">School department</label>
                      <div className="relative">
                        <Building2 className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${fieldErrors.department ? 'text-red-400' : 'text-white/40'}`} />
                        <select id="reg-department" name="department" autoComplete="organization" value={form.department} onChange={set('department')} required
                          className={`${INPUT} pl-9 pr-3 appearance-none cursor-pointer ${err('department')}`}>
                          <option value="" disabled className="bg-[#1e1b5e] text-white">Select your department</option>
                          {DEPARTMENTS.map(d => <option key={d} value={d} className="bg-[#1e1b5e] text-white">{d}</option>)}
                        </select>
                      </div>
                      <ErrMsg field="department" />
                    </div>

                    <div>
                      <label htmlFor="reg-email" className="block text-xs font-semibold text-white/75 mb-1">School email</label>
                      <div className={`flex h-10 rounded-xl border focus-within:ring-2 transition overflow-hidden ${fieldErrors.emailPrefix
                        ? 'border-red-400/60 bg-red-500/10 focus-within:border-red-400/60 focus-within:ring-red-500/10'
                        : 'border-white/[0.15] bg-white/[0.07] focus-within:bg-white/[0.12] focus-within:border-[#F5C900]/60 focus-within:ring-[#F5C900]/10'
                        }`}>
                        <div className="flex items-center pl-3 flex-shrink-0">
                          <AtSign className={`w-4 h-4 ${fieldErrors.emailPrefix ? 'text-red-400' : 'text-white/40'}`} />
                        </div>
                        <input
                          id="reg-email" name="email-prefix"
                          type="text" value={form.emailPrefix} onChange={set('emailPrefix')}
                          required placeholder="username" autoComplete="off"
                          maxLength={64}
                          className="flex-1 px-2 bg-transparent text-sm text-white placeholder-white/35 focus:outline-none"
                        />
                        <span className="px-3 flex items-center bg-white/[0.08] border-l border-white/[0.15] text-xs text-white/50 font-semibold flex-shrink-0">
                          @uspf.edu.ph
                        </span>
                      </div>
                      <ErrMsg field="emailPrefix" />
                    </div>
                  </div>
                </div>

                {/* Section: Security */}
                <div>
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Security</p>
                  <div className="space-y-2">
                    <div>
                      <label htmlFor="reg-password" className="block text-xs font-semibold text-white/75 mb-1">Password</label>
                      <div className="relative">
                        <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${fieldErrors.password ? 'text-red-400' : 'text-white/40'}`} />
                        <input
                          id="reg-password" name="password"
                          type={showPass ? 'text' : 'password'} value={form.password}
                          onChange={set('password')} required minLength={8} maxLength={128}
                          placeholder="Minimum 8 characters" autoComplete="new-password"
                          className={`${INPUT} pl-9 pr-11 ${err('password')}`}
                        />
                        <button type="button" onClick={() => setShowPass(v => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition p-0.5">
                          {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {form.password && !fieldErrors.password && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="flex gap-1 flex-1">
                            {[1, 2, 3, 4].map(n => (
                              <div key={n} className={`flex-1 h-1 rounded-full transition-all ${n <= strength ? strengthMeta[strength].color : 'bg-white/10'}`} />
                            ))}
                          </div>
                          <span className="text-xs font-semibold text-white/50 w-12 text-right">{strengthMeta[strength].label}</span>
                        </div>
                      )}
                      <ErrMsg field="password" />
                    </div>

                    <div>
                      <label htmlFor="reg-confirm" className="block text-xs font-semibold text-white/75 mb-1">Confirm password</label>
                      <div className="relative">
                        <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${fieldErrors.confirm ? 'text-red-400' : 'text-white/40'}`} />
                        <input
                          id="reg-confirm" name="confirm-password"
                          type={showConfirm ? 'text' : 'password'} value={form.confirm}
                          onChange={set('confirm')} required minLength={8} maxLength={128}
                          placeholder="Repeat password" autoComplete="new-password"
                          className={`${INPUT} pl-9 pr-11 ${err('confirm')} ${!fieldErrors.confirm && form.confirm && form.confirm !== form.password
                            ? 'border-red-400/60 focus:border-red-400/60 focus:ring-red-500/10'
                            : ''
                            }`}
                        />
                        <button type="button" onClick={() => setShowConfirm(v => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition p-0.5">
                          {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      <ErrMsg field="confirm" />
                    </div>
                  </div>
                </div>

                {/* Terms */}
                <label htmlFor="reg-terms" className="flex items-start gap-2.5 cursor-pointer">
                  <input id="reg-terms" name="terms" type="checkbox" required className="mt-0.5 accent-[#F5C900] flex-shrink-0 w-4 h-4" />
                  <span className="text-xs text-white/50 leading-relaxed">
                    I agree to the{' '}
                    <span className="text-[#F5C900] font-semibold hover:underline cursor-pointer">Terms of Service</span>
                    {' '}and{' '}
                    <span className="text-[#F5C900] font-semibold hover:underline cursor-pointer">Privacy Policy</span>.
                  </span>
                </label>

                <button
                  type="submit" disabled={loading || success}
                  className="w-full h-11 bg-[#262367] text-white rounded-xl text-sm font-bold hover:bg-[#1e1b5e] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-black/30"
                >
                  {loading
                    ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg><span>Creating account…</span></>
                    : <><span>Create account</span><ArrowRight className="w-4 h-4" /></>}
                </button>
              </form>
            </div>

            {/* Card footer */}
            <div className="px-6 py-3.5 border-t border-white/[0.10] text-center">
              <p className="text-sm text-white/50">
                Already have an account?{' '}
                <Link to="/" className="text-[#F5C900] font-bold hover:underline">Sign in</Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
