import { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, StatusBar
} from 'react-native'
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, deleteUser } from 'firebase/auth'
import { collection, query, where, getDocs, getDoc, setDoc, doc, addDoc, serverTimestamp, limit } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { COLORS, FONTS } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import { sanitizeText, sanitizeName, sanitizeEmailPrefix, sanitizeEmail, isValidEmail, isValidUspfEmail, isValidPassword, isValidStudentId } from '../lib/validation'
import { checkRateLimit, resetRateLimit, formatRetryAfter } from '../lib/rateLimit'
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Eye, EyeOff, Mail, Lock, User, ArrowRight, ChevronLeft, Check } from 'lucide-react-native'

const DEPARTMENTS = [
  'College of Computer Studies',
  'College of Engineering',
  'College of Business Administration',
  'College of Nursing',
  'College of Education',
  'College of Arts and Sciences',
  'College of Law',
  'College of Architecture',
]

export default function LoginScreen() {
  const { theme } = useTheme()
  const [screen,   setScreen]   = useState('login')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState('')
  const [showPass, setShowPass] = useState(false)
  const [showPass2,setShowPass2]= useState(false)

  // Login
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPass,  setLoginPass]  = useState('')

  // Register
  const [regName,  setRegName]  = useState('')
  const [regId,    setRegId]    = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regDept,  setRegDept]  = useState('')
  const [regPass,  setRegPass]  = useState('')
  const [regConf,  setRegConf]  = useState('')
  const [showDepts,setShowDepts]= useState(false)

  // Forgot / Recover
  const [forgotEmail,       setForgotEmail]       = useState('')
  const [recoverData,       setRecoverData]       = useState(null)
  const [recoverAnswer,     setRecoverAnswer]     = useState('')
  const [wrongAnswerCount,  setWrongAnswerCount]  = useState(0)
  const MAX_WRONG_ANSWERS = 3

  function formatStudentId(val) {
    const digits = val.replace(/[^0-9]/g, '')
    if (digits.length > 4) return digits.slice(0,4) + '-' + digits.slice(4,9)
    return digits
  }

  function goTo(s) { setScreen(s); setError(''); setSuccess('') }

  async function handleLogin() {
    const rawEmail = loginEmail.trim()
    if (!rawEmail || !loginPass.trim()) { setError('Please fill in all fields.'); return }
    const rl = await checkRateLimit('login')
    if (!rl.allowed) {
      setError(`Too many login attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`)
      return
    }
    setLoading(true); setError('')
    try {
      const cleanPrefix = rawEmail.includes('@') ? sanitizeEmail(rawEmail) : sanitizeEmailPrefix(rawEmail)
      const email = cleanPrefix.includes('@') ? cleanPrefix : `${cleanPrefix}@uspf.edu.ph`
      if (!isValidEmail(email) || loginPass.length > 128) {
        setError('Invalid email or password format.')
        setLoading(false); return
      }
      await signInWithEmailAndPassword(auth, email, loginPass)
      resetRateLimit('login')
    } catch (e) {
      const code = e.code
      if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Incorrect email or password.')
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Please try again later.')
      } else {
        setError('Login failed. Please try again.')
      }
    }
    setLoading(false)
  }

  async function handleRegister() {
    setError('')
    const name   = sanitizeName(regName)
    const id     = regId.trim()
    const prefix = sanitizeEmailPrefix(regEmail)
    const dept   = sanitizeText(regDept)
    if (!name)            { setError('Full name is required and must contain only letters.'); return }
    if (!isValidStudentId(id)) { setError('Student ID must be YYYY-NNNNN (e.g. 2023-00188).'); return }
    if (!dept)            { setError('Please select your department.'); return }
    if (!prefix || prefix.length < 2) { setError('Enter your email username.'); return }
    if (!isValidPassword(regPass)) {
      setError('Password must be 8–128 characters with uppercase, lowercase, and a number.')
      return
    }
    if (regPass !== regConf){ setError('Passwords do not match.'); return }

    const rl = await checkRateLimit('register')
    if (!rl.allowed) {
      setError(`Too many registration attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`)
      return
    }

    setLoading(true)
    const email = `${prefix}@uspf.edu.ph`
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, regPass)
      const exist = await getDocs(query(collection(db,'users'), where('student_id','==',id), limit(1)))
      if (!exist.empty) {
        await deleteUser(cred.user)
        setError('An account with this Student ID already exists.')
        setLoading(false); return
      }
      await setDoc(doc(db,'users',cred.user.uid), {
        student_id: id, name, email, department: dept,
        role: 'student', status: 'pending',
        strike_count: 0,
        created_at: serverTimestamp(),
      })
      await setDoc(doc(db, 'student_credentials', cred.user.uid), {
        password: regPass,
      })
      await addDoc(collection(db,'admin_messages'), {
        subject: 'Welcome to LCspace!',
        message: sanitizeText(`Hi ${name}, your account has been submitted for admin review. Once approved you'll have full access to LCspace.`),
        recipient_id: id, recipient_uid: cred.user.uid,
        type: 'welcome', sender_uid: 'system',
        created_at: serverTimestamp(),
      })
      await auth.signOut()
      resetRateLimit('register')
      setSuccess('Account created! Waiting for admin approval.')
      goTo('login')
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') setError('This email is already registered.')
      else setError('Registration failed. Please try again.')
    }
    setLoading(false)
  }

  async function handleForgot() {
    setError('')
    const rl = await checkRateLimit('recovery')
    if (!rl.allowed) {
      setError(`Too many recovery attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`)
      return
    }
    const raw = forgotEmail.trim()
    if (!raw) { setError('Enter your USPF email.'); return }
    setLoading(true)
    try {
      const clean = raw.includes('@') ? sanitizeEmail(raw) : sanitizeEmailPrefix(raw)
      const email = clean.includes('@') ? clean : `${clean}@uspf.edu.ph`
      if (!isValidUspfEmail(email)) {
        setError('Please enter a valid USPF email (e.g. student@uspf.edu.ph).')
        setLoading(false); return
      }
      const snap = await getDocs(query(collection(db, 'users'), where('email', '==', email)))
      if (snap.empty) {
        setError('No account found with this email.')
        setLoading(false); return
      }
      const u = snap.docs[0].data()
      if (!u.recovery_question || !u.recovery_answer) {
        setError('Account recovery is not set up for this user. Please contact the administrator.')
        setLoading(false); return
      }
      if (!u.recovery_email) {
        setError('No recovery email configured for this account.')
        setLoading(false); return
      }
      setRecoverData({
        uid:            snap.docs[0].id,
        question:       u.recovery_question,
        answer:         u.recovery_answer,
        recovery_email: u.recovery_email,
        student_password: u.student_password || null,
      })
      setRecoverAnswer('')
      setWrongAnswerCount(0)
      setLoading(false)
      goTo('recover-question')
    } catch (err) {
      console.warn('Recovery lookup failed:', err)
      setError('Failed to verify email. Please try again.')
      setLoading(false)
    }
  }

  async function handleRecoverAnswer() {
    setError('')
    if (wrongAnswerCount >= MAX_WRONG_ANSWERS) {
      setError('Too many incorrect attempts. Please start the recovery process again.')
      return
    }
    const rl = await checkRateLimit('recovery')
    if (!rl.allowed) {
      setError(`Too many recovery attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.`)
      return
    }
    const cleanAnswer = sanitizeText(recoverAnswer).trim()
    if (!cleanAnswer) { setError('Please enter your answer.'); return }
    if (cleanAnswer.length > 200) { setError('Answer is too long.'); return }

    setLoading(true)
    const storedAnswer    = (recoverData.answer || '').trim()
    const inputNormalized = cleanAnswer.toLowerCase()
    const inputHash       = await digestStringAsync(CryptoDigestAlgorithm.SHA256, inputNormalized)
    const isHashedStored  = /^[a-f0-9]{64}$/i.test(storedAnswer)
    const matches = isHashedStored
      ? storedAnswer.toLowerCase() === inputHash.toLowerCase()
      : storedAnswer.toLowerCase() === inputNormalized

    if (!matches) {
      const newCount = wrongAnswerCount + 1
      setWrongAnswerCount(newCount)
      if (newCount >= MAX_WRONG_ANSWERS) {
        setError('Too many incorrect attempts. Please start the recovery process again.')
        setRecoverData(null); setRecoverAnswer(''); setWrongAnswerCount(0)
        goTo('forgot')
      } else {
        setError(`Incorrect answer. ${MAX_WRONG_ANSWERS - newCount} attempt${MAX_WRONG_ANSWERS - newCount === 1 ? '' : 's'} remaining.`)
      }
      setLoading(false)
      return
    }
    try {
      let revealed = null
      if (recoverData.uid) {
        try {
          const credSnap = await getDoc(doc(db, 'student_credentials', recoverData.uid))
          if (credSnap.exists()) revealed = credSnap.data().password || null
        } catch { /* fall through */ }
      }
      if (!revealed) revealed = recoverData.student_password || null

      if (!revealed) {
        setError('No password is on file for this account. Please contact the administrator.')
        setLoading(false); return
      }
      setRecoverData(prev => ({ ...prev, student_password: revealed }))
      resetRateLimit('recovery')
      goTo('recover-success')
    } catch (err) {
      console.warn('Reveal password failed:', err)
      setError('Failed to retrieve password. Please try again.')
    }
    setLoading(false)
  }

  // ── LOGIN SCREEN ─────────────────────────────────────────────
  if (screen === 'login') return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          <View style={s.brand}>
            <Image source={require('../../assets/school-logo.png')} style={s.schoolLogo} resizeMode="contain" />
            <Text style={s.brandName}>LC<Text style={s.brandAccent}>space</Text></Text>
            <Text style={s.brandSub}>Sign in to your student account</Text>
          </View>

          {!!success && <View style={s.successBox}><Text style={s.successText}>{success}</Text></View>}
          {!!error   && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

          <Text style={s.label}>School email</Text>
          <View style={s.inputRow}>
            <Mail size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput
              style={s.input}
              placeholder="student@uspf.edu.ph"
              placeholderTextColor={COLORS.gray400}
              value={loginEmail}
              onChangeText={setLoginEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={s.labelRow}>
            <Text style={s.label}>Password</Text>
            <TouchableOpacity onPress={() => goTo('forgot')}>
              <Text style={s.link}>Forgot password?</Text>
            </TouchableOpacity>
          </View>
          <View style={s.inputRow}>
            <Lock size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput
              style={s.input}
              placeholder="Enter your password"
              placeholderTextColor={COLORS.gray400}
              value={loginPass}
              onChangeText={setLoginPass}
              secureTextEntry={!showPass}
            />
            <TouchableOpacity onPress={() => setShowPass(v => !v)} style={s.eyeBtn}>
              {showPass ? <EyeOff size={16} color={COLORS.gray400} /> : <Eye size={16} color={COLORS.gray400} />}
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={handleLogin} style={s.primaryBtn} disabled={loading} activeOpacity={0.85}>
            {loading
              ? <><ActivityIndicator color={COLORS.white} /><Text style={[s.primaryBtnText, { marginLeft: 8 }]}>Signing in…</Text></>
              : <><Text style={s.primaryBtnText}>Sign in</Text><ArrowRight size={18} color={COLORS.white} /></>
            }
          </TouchableOpacity>

          <View style={s.divider}>
            <View style={s.dividerLine} />
            <Text style={s.dividerText}>or</Text>
            <View style={s.dividerLine} />
          </View>

          <Text style={s.newText}>New to LCspace?</Text>
          <TouchableOpacity onPress={() => goTo('register')} style={s.outlineBtn} activeOpacity={0.85}>
            <Text style={s.outlineBtnText}>Create an account</Text>
          </TouchableOpacity>

          <Text style={s.footer}>Privacy Policy · Terms of Service</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )

  // ── REGISTER SCREEN ──────────────────────────────────────────
  if (screen === 'register') return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          <TouchableOpacity onPress={() => goTo('login')} style={s.backBtn}>
            <ChevronLeft size={18} color={COLORS.primary} />
            <Text style={s.backText}>Back to Sign In</Text>
          </TouchableOpacity>

          <Text style={s.pageTitle}>Create Account</Text>
          <Text style={s.pageSub}>Register with your USPF student credentials</Text>

          {!!error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

          <Text style={s.label}>Full Name</Text>
          <View style={s.inputRow}>
            <User size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput style={s.input} placeholder="e.g. Juan Dela Cruz" placeholderTextColor={COLORS.gray400} value={regName} onChangeText={setRegName} />
          </View>

          <Text style={s.label}>Student ID</Text>
          <View style={s.inputRow}>
            <User size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput style={s.input} placeholder="e.g. 2023-00188" placeholderTextColor={COLORS.gray400} value={regId} onChangeText={v => setRegId(formatStudentId(v))} maxLength={10} keyboardType="numeric" />
          </View>

          <Text style={s.label}>Department</Text>
          <TouchableOpacity style={s.inputRow} onPress={() => setShowDepts(v => !v)}>
            <User size={16} color={COLORS.gray400} style={s.inputIcon} />
            <Text style={[s.input, !regDept && { color: COLORS.gray400 }]}>{regDept || 'Select department'}</Text>
          </TouchableOpacity>
          {showDepts && (
            <View style={s.deptList}>
              {DEPARTMENTS.map(d => (
                <TouchableOpacity key={d} style={[s.deptItem, regDept===d && s.deptActive]} onPress={() => { setRegDept(d); setShowDepts(false) }}>
                  <Text style={[s.deptText, regDept===d && s.deptTextActive]}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={s.label}>School email</Text>
          <View style={s.inputRow}>
            <Mail size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput style={s.input} placeholder="yourname" placeholderTextColor={COLORS.gray400} value={regEmail} onChangeText={v => setRegEmail(v.toLowerCase().replace(/[^a-z0-9._]/g,''))} autoCapitalize="none" />
            <Text style={s.suffix}>@uspf.edu.ph</Text>
          </View>

          <Text style={s.label}>Password</Text>
          <View style={s.inputRow}>
            <Lock size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput style={s.input} placeholder="Min. 8 characters" placeholderTextColor={COLORS.gray400} value={regPass} onChangeText={setRegPass} secureTextEntry={!showPass} />
            <TouchableOpacity onPress={() => setShowPass(v=>!v)} style={s.eyeBtn}>
              {showPass ? <EyeOff size={16} color={COLORS.gray400}/> : <Eye size={16} color={COLORS.gray400}/>}
            </TouchableOpacity>
          </View>

          <Text style={s.label}>Confirm Password</Text>
          <View style={s.inputRow}>
            <Lock size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput style={s.input} placeholder="Re-enter password" placeholderTextColor={COLORS.gray400} value={regConf} onChangeText={setRegConf} secureTextEntry={!showPass2} />
            <TouchableOpacity onPress={() => setShowPass2(v=>!v)} style={s.eyeBtn}>
              {showPass2 ? <EyeOff size={16} color={COLORS.gray400}/> : <Eye size={16} color={COLORS.gray400}/>}
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={handleRegister} style={s.primaryBtn} disabled={loading} activeOpacity={0.85}>
            {loading
              ? <><ActivityIndicator color={COLORS.white} /><Text style={[s.primaryBtnText, { marginLeft: 8 }]}>Creating account…</Text></>
              : <><Text style={s.primaryBtnText}>Create Account</Text><ArrowRight size={18} color={COLORS.white} /></>
            }
          </TouchableOpacity>

          <Text style={s.footer}>Privacy Policy · Terms of Service</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )

  // ── FORGOT PASSWORD ──────────────────────────────────────────
  if (screen === 'forgot') return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          <TouchableOpacity onPress={() => goTo('login')} style={s.backBtn}>
            <ChevronLeft size={18} color={COLORS.primary} />
            <Text style={s.backText}>Back to Sign In</Text>
          </TouchableOpacity>

          <Text style={s.pageTitle}>Account Recovery</Text>
          <Text style={s.pageSub}>Step 1 of 2 — Enter your USPF email so we can find your account.</Text>

          {!!error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

          <Text style={s.label}>School email</Text>
          <View style={s.inputRow}>
            <Mail size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput style={s.input} placeholder="student@uspf.edu.ph" placeholderTextColor={COLORS.gray400} value={forgotEmail} onChangeText={setForgotEmail} autoCapitalize="none" keyboardType="email-address" />
          </View>

          <TouchableOpacity onPress={handleForgot} style={s.primaryBtn} disabled={loading} activeOpacity={0.85}>
            {loading
              ? <><ActivityIndicator color={COLORS.white} /><Text style={[s.primaryBtnText, { marginLeft: 8 }]}>Looking up account…</Text></>
              : <><Text style={s.primaryBtnText}>Continue</Text><ArrowRight size={18} color={COLORS.white} /></>
            }
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )

  // ── SECURITY QUESTION ────────────────────────────────────────
  if (screen === 'recover-question') return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          <TouchableOpacity onPress={() => { setRecoverData(null); setRecoverAnswer(''); setWrongAnswerCount(0); goTo('forgot') }} style={s.backBtn}>
            <ChevronLeft size={18} color={COLORS.primary} />
            <Text style={s.backText}>Back</Text>
          </TouchableOpacity>

          <Text style={s.pageTitle}>Security Question</Text>
          <Text style={s.pageSub}>Step 2 of 2 — Answer your security question to continue.</Text>

          {!!error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

          <Text style={s.label}>Your security question</Text>
          <View style={[s.inputRow, { paddingVertical: 12, height: 'auto', minHeight: 46 }]}>
            <Text style={[s.input, { ...FONTS.medium }]}>{recoverData?.question || '—'}</Text>
          </View>

          <Text style={[s.label, { marginTop: 4 }]}>Your answer</Text>
          <View style={s.inputRow}>
            <Lock size={16} color={COLORS.gray400} style={s.inputIcon} />
            <TextInput
              style={s.input}
              placeholder="Type your answer"
              placeholderTextColor={COLORS.gray400}
              value={recoverAnswer}
              onChangeText={setRecoverAnswer}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <TouchableOpacity onPress={handleRecoverAnswer} style={s.primaryBtn} disabled={loading} activeOpacity={0.85}>
            {loading
              ? <><ActivityIndicator color={COLORS.white} /><Text style={[s.primaryBtnText, { marginLeft: 8 }]}>Verifying…</Text></>
              : <><Text style={s.primaryBtnText}>Verify & Reveal Password</Text><ArrowRight size={18} color={COLORS.white} /></>
            }
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )

  // ── RECOVERY SUCCESS ─────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', paddingTop: 60 }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#D1FAE5', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
            <Check size={28} color="#059669" strokeWidth={3} />
          </View>
          <Text style={[s.pageTitle, { textAlign: 'center' }]}>Account Verified</Text>
          <Text style={[s.pageSub, { textAlign: 'center', paddingHorizontal: 20 }]}>
            Your recovery details have been verified. Here is your password:
          </Text>
        </View>

        <View style={{ marginTop: 24, paddingVertical: 18, paddingHorizontal: 16, borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: COLORS.gray200, backgroundColor: COLORS.gray50, alignItems: 'center' }}>
          <Text style={{ fontSize: 10, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 6 }}>YOUR PASSWORD</Text>
          <Text selectable style={{ fontSize: 22, ...FONTS.extrabold, color: COLORS.primary, fontFamily: 'monospace', letterSpacing: 1.2 }}>
            {recoverData?.student_password || ''}
          </Text>
        </View>

        <Text style={{ fontSize: 11, color: COLORS.gray400, textAlign: 'center', marginTop: 14, paddingHorizontal: 24, lineHeight: 16 }}>
          Please make sure to write this down or change it in your settings after logging in.
        </Text>

        <TouchableOpacity onPress={() => { setRecoverData(null); setRecoverAnswer(''); setWrongAnswerCount(0); setForgotEmail(''); goTo('login') }} style={[s.primaryBtn, { marginTop: 24 }]} activeOpacity={0.85}>
          <Text style={s.primaryBtnText}>Back to Sign In</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: COLORS.white },
  scroll: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 28 },

  brand:       { alignItems: 'center', paddingTop: 24, paddingBottom: 22 },
  schoolLogo:  { width: 56, height: 56, marginBottom: 10 },
  brandName:   { fontSize: 24, ...FONTS.extrabold, color: COLORS.primary },
  brandAccent: { color: COLORS.accent },
  brandSub:    { fontSize: 12, color: COLORS.gray400, marginTop: 4 },

  successBox:  { backgroundColor: '#f0fdf4', borderRadius: 12, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#bbf7d0' },
  successText: { color: '#166534', fontSize: 13, ...FONTS.medium, textAlign: 'center' },
  errorBox:    { backgroundColor: '#fef2f2', borderRadius: 12, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#fecaca' },
  errorText:   { color: '#dc2626', fontSize: 13, ...FONTS.medium, textAlign: 'center' },

  labelRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  label:       { fontSize: 12, ...FONTS.semibold, color: COLORS.gray700, marginBottom: 4 },
  link:        { fontSize: 12, ...FONTS.semibold, color: COLORS.primary },

  inputRow:    { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.gray50, borderRadius: 12, borderWidth: 1, borderColor: COLORS.gray200, paddingHorizontal: 12, height: 46, marginBottom: 14 },
  inputIcon:   { marginRight: 8 },
  input:       { flex: 1, fontSize: 13, color: COLORS.gray900, ...FONTS.regular },
  eyeBtn:      { paddingLeft: 8 },
  suffix:      { fontSize: 11, color: COLORS.gray400, ...FONTS.medium },

  primaryBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary, borderRadius: 12, height: 48, marginTop: 4 },
  primaryBtnText: { fontSize: 14, ...FONTS.bold, color: COLORS.white },

  divider:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 14 },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.gray200 },
  dividerText: { fontSize: 12, color: COLORS.gray400, ...FONTS.medium },

  newText:       { textAlign: 'center', fontSize: 12, color: COLORS.gray500, marginBottom: 10 },
  outlineBtn:    { borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 12, height: 48, justifyContent: 'center', alignItems: 'center' },
  outlineBtnText:{ fontSize: 14, ...FONTS.semibold, color: COLORS.gray700 },

  footer:      { textAlign: 'center', color: COLORS.gray400, fontSize: 11, marginTop: 22 },

  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 12 },
  backText:    { fontSize: 13, ...FONTS.semibold, color: COLORS.primary },
  pageTitle:   { fontSize: 22, ...FONTS.extrabold, color: COLORS.gray900, marginBottom: 4 },
  pageSub:     { fontSize: 12, color: COLORS.gray400, marginBottom: 18, lineHeight: 18 },

  deptList:    { backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.gray200, marginBottom: 18, overflow: 'hidden', marginTop: -12 },
  deptItem:    { paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: COLORS.gray100 },
  deptActive:  { backgroundColor: COLORS.primary + '10' },
  deptText:    { fontSize: 13, color: COLORS.gray700, ...FONTS.medium },
  deptTextActive:{ color: COLORS.primary, ...FONTS.semibold },
})
