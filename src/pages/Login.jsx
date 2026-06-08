import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { Mail, Lock, Eye, EyeOff, AlertCircle, CalendarCheck, Users, BookOpen, ArrowRight, ArrowLeft, CheckCircle2 } from 'lucide-react'
import { checkRateLimit, resetRateLimit, formatRetryAfter } from '../lib/rateLimit'
import { sanitizeText, sanitizeEmail, isValidUspfEmail, isValidEmail } from '../lib/validation'
import { sha256 } from '../lib/crypto'

function mapAuthError(err) {
  const code = err?.code || ''
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.'
  if (code === 'auth/too-many-requests') return 'Too many failed attempts. Please wait before trying again.'
  if (code === 'auth/user-disabled') return 'This account has been disabled. Contact the admin.'
  if (code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-email') return 'Invalid email or password.'
  return 'Sign-in failed. Please try again.'
}

const DEV_MODE = false

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  // Recovery State
  const [viewState, setViewState] = useState('login'); // 'login', 'recover-email', 'recover-question', 'recover-success'
  const [recoverEmail, setRecoverEmail] = useState('');
  const [recoverData, setRecoverData] = useState(null); // { question, answer }
  const [recoverAnswerInput, setRecoverAnswerInput] = useState('');
  const [recoverError, setRecoverError] = useState('');
  const [recoverLoading, setRecoverLoading] = useState(false);
  const [wrongAnswerCount, setWrongAnswerCount] = useState(0);
  const MAX_WRONG_ANSWERS = 3;

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    // ── 1. Input validation ───────────────────────────────────
    const cleanEmail = sanitizeEmail(email)
    if (!isValidEmail(cleanEmail)) {
      setError('Please enter a valid email address.')
      return
    }
    if (!password || password.length < 1) {
      setError('Please enter your password.')
      return
    }
    if (password.length > 128) {
      setError('Password is too long.')
      return
    }

    // ── 2. Rate limit ─────────────────────────────────────────
    const rl = checkRateLimit('login')
    if (!rl.allowed) {
      setError(`Too many login attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`)
      return
    }

    setLoading(true)

    if (DEV_MODE) {
      const emailVal = email || 'dev@lcspace.edu'
      const namePart = emailVal.split('@')[0]
      const displayName = namePart.replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      sessionStorage.setItem('dev_user', JSON.stringify({
        id: 'dev-bypass-001', student_id: 'DEV-0000',
        name: displayName || 'Dev Student', email: emailVal,
        role: 'student', status: 'ACTIVE', strike_count: 0,
      }))
      setTimeout(() => navigate('/dashboard'), 400)
      return
    }

    try {
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, password)
      const snap = await getDoc(doc(db, 'users', cred.user.uid))
      const status = snap.exists() ? snap.data().status : null

      if (status === 'pending') {
        await signOut(auth)
        setError('Your account is pending admin approval. Please wait.')
        setLoading(false); return
      }
      if (status === 'rejected') {
        await signOut(auth)
        setError('Your registration was rejected. Contact the admin.')
        setLoading(false); return
      }
      if (status === 'SUSPENDED') {
        await signOut(auth)
        setError('Your account has been suspended. Contact the admin.')
        setLoading(false); return
      }
      navigate('/dashboard')
      resetRateLimit('login')
    } catch (err) {
      setError(mapAuthError(err))
      setLoading(false)
    }
  }

  const handleRecoverEmailSubmit = async (e) => {
    e.preventDefault();
    setRecoverError('');

    // Check rate limit for recovery attempts
    const rl = checkRateLimit('recovery');
    if (!rl.allowed) {
      setRecoverError(`Too many recovery attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`);
      return;
    }

    setRecoverLoading(true);

    // Sanitize and validate recovery email input
    const cleanRecoverEmail = sanitizeEmail(recoverEmail);
    if (!cleanRecoverEmail) {
      setRecoverError('Please enter your school email address.');
      setRecoverLoading(false);
      return;
    }
    if (!isValidUspfEmail(cleanRecoverEmail)) {
      setRecoverError('Please enter a valid USPF email address (e.g. student@uspf.edu.ph).');
      setRecoverLoading(false);
      return;
    }

    try {
      const q = query(collection(db, 'users'), where('email', '==', cleanRecoverEmail));
      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        setRecoverError('No account found with this email.');
        setRecoverLoading(false);
        return;
      }
      const userData = snapshot.docs[0].data();
      if (!userData.recovery_question || !userData.recovery_answer) {
        setRecoverError('Account recovery is not set up for this user. Please contact the administrator.');
        setRecoverLoading(false);
        return;
      }
      if (!userData.recovery_email) {
        setRecoverError('No recovery email configured for this account.');
        setRecoverLoading(false);
        return;
      }

      setRecoverData({
        uid: snapshot.docs[0].id,
        question: userData.recovery_question,
        answer: userData.recovery_answer,
        recovery_email: userData.recovery_email,
        // Legacy fallback — accounts that haven't been migrated still have this here
        student_password: userData.student_password || null,
      });
      setViewState('recover-question');
    } catch (err) {
      console.error(err);
      setRecoverError('Failed to verify email. Please try again.');
    }
    setRecoverLoading(false);
  };

  const handleRecoverAnswerSubmit = async (e) => {
    e.preventDefault();
    setRecoverError('');

    // Lock if too many wrong answers in this session
    if (wrongAnswerCount >= MAX_WRONG_ANSWERS) {
      setRecoverError('Too many incorrect attempts. Please start the recovery process again.');
      return;
    }

    // Check rate limit for recovery attempts
    const rl = checkRateLimit('recovery');
    if (!rl.allowed) {
      setRecoverError(`Too many recovery attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`);
      return;
    }

    // Validate answer is not empty
    const cleanAnswerInput = sanitizeText(recoverAnswerInput).trim();
    if (!cleanAnswerInput) {
      setRecoverError('Please enter your answer.');
      setRecoverLoading(false);
      return;
    }
    if (cleanAnswerInput.length > 200) {
      setRecoverError('Answer is too long.');
      setRecoverLoading(false);
      return;
    }

    setRecoverLoading(true);

    // Stored answer may be a SHA-256 hex hash (64 chars) or legacy plaintext.
    // Hash the user's input and compare both ways for backward compatibility.
    const storedAnswer = (recoverData.answer || '').trim()
    const inputNormalized = cleanAnswerInput.toLowerCase()
    const inputHash = await sha256(inputNormalized)
    const isHashedStored = /^[a-f0-9]{64}$/i.test(storedAnswer)
    const matches = isHashedStored
      ? storedAnswer.toLowerCase() === inputHash.toLowerCase()
      : storedAnswer.toLowerCase() === inputNormalized

    if (!matches) {
      const newCount = wrongAnswerCount + 1;
      setWrongAnswerCount(newCount);
      if (newCount >= MAX_WRONG_ANSWERS) {
        setRecoverError('Too many incorrect attempts. Please start the recovery process again.');
        setViewState('recover-email');
        setRecoverData(null);
        setRecoverAnswerInput('');
        setWrongAnswerCount(0);
      } else {
        setRecoverError(`Incorrect answer. ${MAX_WRONG_ANSWERS - newCount} attempt${MAX_WRONG_ANSWERS - newCount === 1 ? '' : 's'} remaining.`);
      }
      setRecoverLoading(false);
      return;
    }
    try {
      // Fetch the password from the student_credentials collection.
      // Falls back to the legacy `student_password` field on the user doc
      // for accounts that pre-date the credentials-collection migration.
      let revealedPassword = null
      if (recoverData.uid) {
        try {
          const credSnap = await getDoc(doc(db, 'student_credentials', recoverData.uid))
          if (credSnap.exists()) revealedPassword = credSnap.data().password || null
        } catch { /* fall through to legacy */ }
      }
      if (!revealedPassword) revealedPassword = recoverData.student_password || null

      if (!revealedPassword) {
        setRecoverError('No password is on file for this account. Please contact the administrator.')
        setRecoverLoading(false)
        return
      }
      setRecoverData(prev => ({ ...prev, student_password: revealedPassword }))
      setViewState('recover-success');
      resetRateLimit('recovery');
    } catch (err) {
      console.error(err);
      setRecoverError('Failed to retrieve password. Please try again.');
    }
    setRecoverLoading(false);
  };

  const FEATURES = [
    { Icon: CalendarCheck, label: 'Reserve study rooms and labs instantly' },
    { Icon: Users, label: 'Collaborate in shared learning spaces' },
    { Icon: BookOpen, label: 'Access DOST STARBOOKS and digital libraries' },
  ]

  const STATS = [
    { value: '4', label: 'Facilities' },
    { value: '2 hr', label: 'Per session' },
    { value: '24/7', label: 'Online access' },
  ]

  const IMAGES = [
    '/assets/img/collaborative.jpg',
    '/assets/img/innovative.png',
    '/assets/img/DOST-STARBOOKS.png',
    '/assets/img/virtual.jpg',
  ]

  return (
    <div className="h-screen flex bg-white overflow-hidden relative">

      {/* ── Left panel ── */}
      <div className="hidden lg:flex w-[52%] bg-[#1e1b5e] flex-col relative overflow-hidden">

        {/* Decorative circles */}
        <div className="absolute -top-32 -right-32 w-[480px] h-[480px] rounded-full bg-white/[0.04] pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-[320px] h-[320px] rounded-full bg-[#F5C900]/[0.07] pointer-events-none" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-white/[0.02] pointer-events-none" />

        <div className="relative z-10 flex flex-col h-full px-12 py-10">
          <div className="flex items-center gap-3 mb-8">
            <img
              src="/assets/img/Schoollogo.png" alt="USPF"
              className="w-10 h-10 object-contain flex-shrink-0"
              onError={e => { e.target.style.display = 'none' }}
            />
            <div className="leading-none">
              <p className="text-white font-bold text-base tracking-tight">
                LC<span className="text-[#F5C900]">space</span>
              </p>
              <p className="text-white/30 text-[10px] mt-0.5 font-medium tracking-wider">STUDENT PORTAL</p>
            </div>
          </div>

          {/* Headline */}
          <div className="mb-7">
            <h1 className="text-[2.2rem] font-extrabold text-white leading-[1.15] tracking-tight mb-3">
              The academic portal<br />
              for every<br />
              <span className="text-[#F5C900]">USPF student.</span>
            </h1>
            <p className="text-white/50 text-sm leading-relaxed max-w-xs">
              Book study rooms, collaborate with peers, and access campus resources — all from one place.
            </p>
          </div>

          {/* Features */}
          <div className="space-y-3 mb-auto">
            {FEATURES.map(({ Icon, label }) => (
              <div key={label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-white/8 border border-white/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-[#F5C900]" />
                </div>
                <span className="text-white/65 text-sm">{label}</span>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2.5 mt-7 mb-5">
            {STATS.map(s => (
              <div key={s.label} className="bg-white/[0.07] border border-white/10 rounded-2xl px-3 py-3 text-center">
                <p className="text-lg font-extrabold text-white leading-none">{s.value}</p>
                <p className="text-white/35 text-[11px] mt-1 font-medium">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Image grid */}
          <div className="grid grid-cols-4 gap-1.5">
            {IMAGES.map((src, i) => (
              <div key={i} className="h-20 rounded-xl overflow-hidden">
                <img src={src} alt="" className="w-full h-full object-cover"
                  onError={e => { e.currentTarget.parentElement.style.display = 'none' }} />
              </div>
            ))}
          </div>

          <p className="text-white/20 text-[11px] mt-4">University of Southern Philippines Foundation © 2025</p>
        </div>
      </div>

      {/* Mascot */}
      <img
        src="/assets/img/ChatGPT_Image_Jun_6__2026__11_25_19_PM-removebg-preview (1).png"
        alt=""
        className="hidden lg:block absolute bottom-0 z-20 pointer-events-none select-none w-72 drop-shadow-2xl"
        style={{ left: 'calc(52% - 4.6rem)' }}
      />

      {/* ── Right panel ── */}
      <div className="auth-panel flex-1 flex flex-col justify-center items-center px-8 py-8 bg-gradient-to-br from-[#0d1030] via-[#161450] to-[#0b0e1e] relative overflow-hidden">

        {/* Decorative glows */}
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[#F5C900]/[0.05] blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -left-16 w-80 h-80 rounded-full bg-[#2563eb]/[0.07] blur-3xl pointer-events-none" />

        <div className="w-full max-w-[380px] relative z-10">

          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-2 mb-10">
            <img src="/assets/img/Schoollogo.png" alt="USPF" className="w-7 h-7 object-contain"
              onError={e => { e.target.style.display = 'none' }} />
            <span className="font-bold text-white text-base">LC<span className="text-[#F5C900]">space</span></span>
          </div>

          {/* Glass card */}
          <div className="bg-white/[0.06] backdrop-blur-xl border border-white/[0.10] rounded-3xl shadow-2xl shadow-black/40">
            <div className="p-8">

            {/* LOGIN FLOW */}
            {viewState === 'login' && (
              <div>
                <div className="mb-6">
                  <h2 className="text-[1.75rem] font-bold text-white tracking-tight leading-snug">Welcome back</h2>
                  <p className="text-white/50 text-sm mt-1">Sign in with your USPF school credentials.</p>
                </div>

                {error && (
                  <div className="mb-4 flex items-start gap-3 p-3.5 bg-red-500/15 border border-red-400/30 text-red-300 text-sm rounded-xl">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span className="leading-snug">{error}</span>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="login-email" className="block text-sm font-semibold text-white/75 mb-1.5">School email</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                      <input
                        id="login-email" name="email"
                        type="email" value={email} onChange={e => setEmail(e.target.value)}
                        required placeholder="student@uspf.edu.ph" autoComplete="username"
                        className="w-full h-10 pl-10 pr-4 rounded-xl border border-white/[0.15] bg-white/[0.07] text-sm text-white placeholder-white/35 focus:outline-none focus:bg-white/[0.12] focus:border-[#F5C900]/60 focus:ring-2 focus:ring-[#F5C900]/10 transition"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label htmlFor="login-password" className="text-sm font-semibold text-white/75">Password</label>
                      <button type="button" onClick={() => { setViewState('recover-email'); setRecoverError(''); setRecoverEmail(''); }} className="text-xs font-medium text-[#F5C900] hover:underline">Forgot password?</button>
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                      <input
                        id="login-password" name="password"
                        type={showPass ? 'text' : 'password'} value={password}
                        onChange={e => setPassword(e.target.value)}
                        required placeholder="Enter your password" autoComplete="current-password"
                        className="w-full h-10 pl-10 pr-11 rounded-xl border border-white/[0.15] bg-white/[0.07] text-sm text-white placeholder-white/35 focus:outline-none focus:bg-white/[0.12] focus:border-[#F5C900]/60 focus:ring-2 focus:ring-[#F5C900]/10 transition"
                      />
                      <button type="button" onClick={() => setShowPass(v => !v)}
                        className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition p-0.5">
                        {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit" disabled={loading}
                    className="w-full h-10 mt-1 bg-[#262367] text-white rounded-xl text-sm font-bold hover:bg-[#1e1b5e] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-black/30"
                  >
                    {loading
                      ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg><span>Signing in…</span></>
                      : <><span>Sign in to Dashboard</span><ArrowRight className="w-4 h-4" /></>}
                  </button>
                </form>

                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-xs text-white/40 font-medium">New to LCspace?</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>

                <Link to="/register"
                  className="flex items-center justify-center w-full h-10 rounded-xl border border-white/20 text-sm font-semibold text-white/70 hover:border-[#F5C900] hover:text-[#F5C900] transition-all">
                  Create an account
                </Link>
              </div>
            )}

            {/* RECOVERY FLOW - EMAIL STEP */}
            {viewState === 'recover-email' && (
              <div>
                <button
                  onClick={() => setViewState('login')}
                  className="flex items-center gap-1.5 text-sm font-semibold text-white/50 hover:text-white mb-6 transition"
                >
                  <ArrowLeft className="w-4 h-4" /> Back to login
                </button>

                <div className="mb-6">
                  <h2 className="text-[1.75rem] font-bold text-white tracking-tight leading-snug">Account Recovery</h2>
                  <p className="text-white/50 text-sm mt-1">Enter your school email to begin.</p>
                </div>

                {recoverError && (
                  <div className="mb-4 flex items-start gap-3 p-3.5 bg-red-500/15 border border-red-400/30 text-red-300 text-sm rounded-xl">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span className="leading-snug">{recoverError}</span>
                  </div>
                )}

                <form onSubmit={handleRecoverEmailSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="recover-email" className="block text-sm font-semibold text-white/75 mb-1.5">School email</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                      <input
                        id="recover-email" name="recover-email"
                        type="email" value={recoverEmail} onChange={e => setRecoverEmail(e.target.value)}
                        required placeholder="student@uspf.edu.ph" maxLength={254} autoComplete="email"
                        className="w-full h-10 pl-10 pr-4 rounded-xl border border-white/[0.15] bg-white/[0.07] text-sm text-white placeholder-white/35 focus:outline-none focus:bg-white/[0.12] focus:border-[#F5C900]/60 focus:ring-2 focus:ring-[#F5C900]/10 transition"
                      />
                    </div>
                  </div>
                  <button
                    type="submit" disabled={recoverLoading}
                    className="w-full h-10 mt-1 bg-[#262367] text-white rounded-xl text-sm font-bold hover:bg-[#1e1b5e] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-black/30"
                  >
                    {recoverLoading ? 'Verifying...' : 'Continue'}
                  </button>
                </form>
              </div>
            )}

            {/* RECOVERY FLOW - QUESTION STEP */}
            {viewState === 'recover-question' && (
              <div>
                <button
                  onClick={() => { setViewState('recover-email'); setRecoverData(null); setRecoverAnswerInput(''); setWrongAnswerCount(0); setRecoverError(''); }}
                  className="flex items-center gap-1.5 text-sm font-semibold text-white/50 hover:text-white mb-6 transition"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <div className="mb-6">
                  <h2 className="text-[1.75rem] font-bold text-white tracking-tight leading-snug">Security Verification</h2>
                  <p className="text-white/50 text-sm mt-1">Answer your security question to continue.</p>
                </div>

                {recoverError && (
                  <div className="mb-4 flex items-start gap-3 p-3.5 bg-red-500/15 border border-red-400/30 text-red-300 text-sm rounded-xl">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span className="leading-snug">{recoverError}</span>
                  </div>
                )}

                <form onSubmit={handleRecoverAnswerSubmit} className="space-y-4">
                  <div className="bg-white/[0.06] p-4 rounded-xl border border-white/[0.12] mb-4">
                    <p className="text-sm font-semibold text-white/60 mb-1">Security Question:</p>
                    <p className="text-sm text-white font-medium">{recoverData?.question}</p>
                  </div>
                  <div>
                    <label htmlFor="recover-answer" className="block text-sm font-semibold text-white/75 mb-1.5">Your Answer / PIN</label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                      <input
                        id="recover-answer" name="recover-answer"
                        type="text" value={recoverAnswerInput} onChange={e => setRecoverAnswerInput(e.target.value)}
                        required placeholder="Enter your answer" maxLength={200} autoComplete="off"
                        className="w-full h-10 pl-10 pr-4 rounded-xl border border-white/[0.15] bg-white/[0.07] text-sm text-white placeholder-white/35 focus:outline-none focus:bg-white/[0.12] focus:border-[#F5C900]/60 focus:ring-2 focus:ring-[#F5C900]/10 transition"
                      />
                    </div>
                  </div>
                  <button
                    type="submit" disabled={recoverLoading}
                    className="w-full h-10 mt-1 bg-[#262367] text-white rounded-xl text-sm font-bold hover:bg-[#1e1b5e] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-black/30"
                  >
                    {recoverLoading ? 'Verifying...' : 'Verify Answer'}
                  </button>
                </form>
              </div>
            )}

            {/* RECOVERY FLOW - SUCCESS STEP */}
            {viewState === 'recover-success' && (
              <div className="text-center py-6">
                <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                </div>
                <h2 className="text-2xl font-bold text-white tracking-tight mb-2">Account Verified</h2>
                <p className="text-white/50 text-sm mb-6 leading-relaxed">
                  Your recovery details have been verified. Here is your password:
                </p>

                <div className="bg-white/[0.06] border-2 border-dashed border-white/20 rounded-2xl p-5 mb-6">
                  <p className="text-xs font-bold uppercase tracking-wider text-white/40 mb-1">Your Password</p>
                  <p className="text-2xl font-extrabold text-[#F5C900] tracking-wider select-all select-text font-mono">
                    {recoverData?.student_password}
                  </p>
                </div>

                <p className="text-xs text-white/35 mb-6 px-4">
                  Please make sure to write this down or change it in your settings after logging in.
                </p>

                <button
                  onClick={() => { setViewState('login'); setRecoverEmail(''); setRecoverAnswerInput(''); setRecoverData(null); }}
                  className="w-full h-10 bg-[#262367] text-white rounded-xl text-sm font-bold hover:bg-[#1e1b5e] active:scale-[0.98] transition-all flex items-center justify-center shadow-lg shadow-black/30"
                >
                  Return to Login
                </button>
              </div>
            )}

            </div>
          </div>{/* end glass card */}

          <p className="mt-5 text-center text-xs text-white/20">
            Privacy Policy · Terms of Service
          </p>
        </div>
      </div>
    </div>
  )
}
