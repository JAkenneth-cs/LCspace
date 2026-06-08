import { useState, useEffect } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ScrollView,
  Alert, StatusBar, Modal, TextInput, ActivityIndicator, Switch, Dimensions,
} from 'react-native'
import { signOut, sendPasswordResetEmail } from 'firebase/auth'
import { doc, updateDoc, collection, addDoc, serverTimestamp, query, where, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { COLORS, FONTS } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  Scale, Clock, ShieldCheck, LogOut,
  FileText, Building, Info, Monitor, Lock, Wifi, Shield,
  Camera, Moon, Sun, ChevronRight, Check, TriangleAlert, Mail, Key, ChevronDown,
  X, PenLine, User, BookOpen,
} from 'lucide-react-native'
import * as ImagePicker from 'expo-image-picker'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import { sanitizeName, sanitizeText, sanitizeEmail, isValidEmail } from '../lib/validation'
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto'
import { useAlert } from '../components/AlertModal'

const SHEET_MAX = Dimensions.get('window').height * 0.62

const SECURITY_QUESTIONS = [
  'Enter your own recovery PIN code',
  "What is your mother's maiden name?",
  "What was the name of your first pet?",
  "What city were you born in?",
  "What was your childhood nickname?",
  "What is the name of your elementary school?",
  "What is your favorite book or movie?",
]

// ── Guide & Rules content ─────────────────────────────────────────
const GUIDE_SECTIONS = [
  {
    title: 'How to Make a Reservation',
    icon: FileText,
    items: [
      'Tap "Reserve" → choose a room, date, time slot, group size, and purpose.',
      'Your reservation starts as Pending and waits for admin approval.',
      'Once Confirmed, visit the LCspace admin desk in person to Check-In.',
      'After check-in, your booking is Active during the reserved time window.',
    ],
  },
  {
    title: 'Reservation Rules',
    icon: FileText,
    items: [
      'Only one reservation per student per day — no duplicates allowed.',
      'Reservations must be made at least 1 hour before the start time.',
      'Cancel is available only for Pending bookings, within 15 minutes of creating it.',
      'After 15 minutes (or once Confirmed), contact the admin desk to cancel.',
      'You can remove a Confirmed / Checked-In / Cancelled booking from your list — admin still keeps the record for audit.',
      'Pending bookings cannot be deleted from your list (only cancelled within the window).',
      'Repeated no-shows will result in strikes on your account.',
    ],
  },
  {
    title: 'Facility Rules',
    icon: Building,
    items: [
      'No food or drinks allowed inside the rooms.',
      'Maintain cleanliness and return furniture to original positions.',
      'Keep noise levels appropriate for a study environment.',
      'Report any damaged equipment to admin immediately.',
      'Maximum occupancy must be respected at all times.',
    ],
  },
  {
    title: 'General Guidelines',
    icon: Info,
    items: [
      'Students must present their USPF ID upon check-in.',
      'Rooms must be vacated promptly at the end of the booking period.',
      'Personal belongings are the responsibility of the student.',
      'LCspace staff have the right to terminate bookings for violations.',
    ],
  },
]

// ── Cyberspace content ───────────────────────────────────────────
const CYBER_SECTIONS = [
  {
    title: 'What is Cyberspace?',
    icon: Monitor,
    items: [
      'Cyberspace is LCspace\'s real-time digital learning hub.',
      'It includes a shared video room, whiteboard, group chat, and screen sharing.',
      'It pairs with your reserved physical room to enable hybrid study sessions.',
      'Once inside, you can invite other registered LCspace students by their Student ID.',
    ],
  },
  {
    title: 'How to Access Cyberspace',
    icon: Lock,
    items: [
      'You must have a Confirmed booking for the current day.',
      'You must Check-In at the LCspace admin desk first.',
      'Your time slot must be active (not too early, not yet expired).',
      'Ask the admin desk for your personal Access Code — each booking has a unique code.',
      'Tap "Cyberspace" on your booking card, enter the code, and the session opens.',
      'You will log in once inside the in-app browser — your session is then remembered.',
    ],
  },
  {
    title: 'Connectivity',
    icon: Wifi,
    items: [
      'USPF Campus Wi-Fi: USPF_Academic (password at front desk).',
      'Wired LAN ports available in Collaborative Rooms.',
      'High-speed WiFi available in all LCspace rooms.',
    ],
  },
  {
    title: 'Responsible Use',
    icon: Shield,
    items: [
      'Use campus internet for academic purposes only.',
      'Downloading unauthorized software is strictly prohibited.',
      'Recording or streaming a Cyberspace session requires consent of all participants.',
      'Any cyber misconduct is subject to USPF disciplinary action.',
      'Report connectivity issues to admin via the Mailbox tab.',
    ],
  },
]

export default function ProfileScreen({ profile }) {
  const { theme, current, setTheme } = useTheme()
  const name = profile?.preferred_name || profile?.name || 'Student'
  const avatar = profile?.photo_url ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.name || 'S')}&background=152243&color=F5C900&size=128&rounded=true`
  const isActive = (profile?.status ?? 'ACTIVE') === 'ACTIVE'
  const strikes = profile?.strike_count ?? 0

  const { showAlert, AlertHost } = useAlert()
  const [modal, setModal] = useState(null)
  const [prefName, setPrefName] = useState(profile?.preferred_name || '')
  const [savingName, setSavingName] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)
  // Account Recovery
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [securityQuestion, setSecurityQuestion] = useState('')
  const [recoveryAnswer, setRecoveryAnswer] = useState('')
  const [savingRecovery, setSavingRecovery] = useState(false)
  const [showQPicker, setShowQPicker] = useState(false)
  // Strike appeals
  const [pendingAppeal, setPendingAppeal] = useState(null)
  const [appealReason, setAppealReason] = useState('')
  const [submittingAppeal, setSubmittingAppeal] = useState(false)

  // Listen for this student's pending appeal (one at a time)
  useEffect(() => {
    if (!profile?.uid) return
    const q = query(collection(db, 'appeals'), where('user_id', '==', profile.uid), where('status', '==', 'pending'))
    const unsub = onSnapshot(q,
      snap => setPendingAppeal(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() }),
      () => { })
    return unsub
  }, [profile?.uid])

  async function submitAppeal() {
    if (!appealReason.trim() || strikes === 0 || pendingAppeal || submittingAppeal) return
    setSubmittingAppeal(true)
    try {
      await addDoc(collection(db, 'appeals'), {
        user_id: profile.uid,
        student_id: profile.student_id,
        student_name: profile.name,
        student_email: profile.email,
        strike_count: profile.strike_count || 0,
        reason: appealReason.trim(),
        status: 'pending',
        created_at: serverTimestamp(),
      })
      setAppealReason('')
      closeModal()
    } catch {
      showAlert('Error', 'Could not submit your appeal. Please try again.')
    }
    setSubmittingAppeal(false)
  }

  function closeModal() { setModal(null); setResetSent(false); setShowQPicker(false) }

  function openRecovery() {
    setRecoveryEmail(profile?.recovery_email || profile?.email || '')
    setSecurityQuestion(profile?.recovery_question || '')
    // Answer is stored hashed — never pre-fill, always require fresh entry.
    setRecoveryAnswer('')
    setModal('recovery')
  }

  async function savePreferredName() {
    const cleanName = sanitizeName(prefName)
    if (!cleanName) { showAlert('Required', 'Enter a valid preferred name (letters only).'); return }
    setSavingName(true)
    try {
      await updateDoc(doc(db, 'users', profile.uid), { preferred_name: cleanName })
      closeModal()
    } catch { showAlert('Error', 'Could not update name.') }
    setSavingName(false)
  }

  async function handlePasswordReset() {
    setSendingReset(true)
    try {
      await sendPasswordResetEmail(auth, profile?.email || '')
      setResetSent(true)
    } catch { showAlert('Error', 'Could not send reset email.') }
    setSendingReset(false)
  }

  async function saveRecovery() {
    const cleanEmail = sanitizeEmail(recoveryEmail)
    const cleanQuestion = sanitizeText(securityQuestion)
    const cleanAnswer = sanitizeText(recoveryAnswer)
    if (!cleanEmail || !isValidEmail(cleanEmail)) { showAlert('Required', 'Enter a valid recovery email address.'); return }
    if (!cleanQuestion) { showAlert('Required', 'Select a security question.'); return }
    if (!cleanAnswer) { showAlert('Required', 'Enter your answer or PIN code.'); return }
    setSavingRecovery(true)
    try {
      // Hash the answer before storing — case-insensitive, trimmed.
      const answerHash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, cleanAnswer.trim().toLowerCase())
      await updateDoc(doc(db, 'users', profile.uid), {
        recovery_email: cleanEmail,
        recovery_question: cleanQuestion,
        recovery_answer: answerHash,
      })
      closeModal()
      showAlert('Saved', 'Your recovery details have been saved.')
    } catch { showAlert('Error', 'Could not save recovery details.') }
    setSavingRecovery(false)
  }

  async function handleLogout() {
    showAlert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => signOut(auth) },
    ])
  }

  const hasRecovery = !!(profile?.recovery_email || profile?.recovery_question)

  // ── Photo upload (3-month cooldown, same rules as website) ──
  const [photoUploading, setPhotoUploading] = useState(false)

  const photoUpdatedAt = profile?.photo_updated_at?.seconds
    ? profile.photo_updated_at.seconds * 1000
    : profile?.photo_updated_at ? new Date(profile.photo_updated_at).getTime() : null

  const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000
  const photoLocked = !!(profile?.photo_url && photoUpdatedAt && (Date.now() - photoUpdatedAt < THREE_MONTHS_MS))
  const unlockDate = photoUpdatedAt
    ? new Date(photoUpdatedAt + THREE_MONTHS_MS).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null

  async function handlePhotoPress() {
    if (photoLocked) {
      showAlert('Photo Locked', `You can change your profile photo again on ${unlockDate}.`)
      return
    }
    showAlert('Profile Photo', 'Choose an option', [
      { text: 'Camera', onPress: () => pickImage('camera') },
      { text: 'Photo Library', onPress: () => pickImage('library') },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  async function pickImage(source) {
    const permResult = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (permResult.status !== 'granted') {
      showAlert('Permission Required', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access in your settings.`)
      return
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1, 1], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions?.Images ?? 'images', allowsEditing: true, aspect: [1, 1], quality: 0.8 })

    if (result.canceled || !result.assets?.[0]?.uri) return

    setPhotoUploading(true)
    try {
      const manipResult = await manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 300, height: 300 } }],
        { compress: 0.8, format: SaveFormat.JPEG, base64: true }
      )
      const dataUrl = `data:image/jpeg;base64,${manipResult.base64}`
      await updateDoc(doc(db, 'users', profile.uid), {
        photo_url: dataUrl,
        photo_updated_at: { seconds: Math.floor(Date.now() / 1000) },
      })
      showAlert('Done', 'Profile photo updated. You can change it again in 3 months.')
    } catch {
      showAlert('Error', 'Could not upload photo. Please try again.')
    }
    setPhotoUploading(false)
  }

  function handleDeletePhoto() {
    if (!profile?.photo_url) return
    showAlert('Delete Photo', 'Remove your profile photo? The 3-month cooldown will still apply.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          setPhotoUploading(true)
          try {
            await updateDoc(doc(db, 'users', profile.uid), { photo_url: null })
          } catch {
            showAlert('Error', 'Could not delete photo.')
          }
          setPhotoUploading(false)
        },
      },
    ])
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <SafeAreaView style={[s.safe, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]} edges={['top']}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.type === 'dark' ? theme.bg : COLORS.primary}
        />
        <ScrollView style={[s.scroll, { backgroundColor: theme.bg }]} contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>

          {/* ── Hero ── */}
          <View style={[s.hero, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]}>
            <Text style={s.appLabel}>PROFILE</Text>
            <View style={s.avatarWrap}>
              <TouchableOpacity onPress={handlePhotoPress} disabled={photoUploading} activeOpacity={0.8}>
                {photoUploading
                  ? <View style={[s.avatar, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' }]}>
                    <ActivityIndicator color={COLORS.white} />
                    <Text style={{ color: COLORS.white, fontSize: 10, marginTop: 4 }}>Uploading…</Text>
                  </View>
                  : <Image source={{ uri: avatar }} style={s.avatar} />
                }
                <View style={[s.statusDot, { backgroundColor: isActive ? COLORS.emerald : COLORS.red }]} />
                {!photoUploading && !photoLocked && (
                  <View style={s.cameraBadge}>
                    <Camera size={10} color={COLORS.white} />
                  </View>
                )}
              </TouchableOpacity>
              {profile?.photo_url && !photoUploading && (
                <TouchableOpacity onPress={handleDeletePhoto} style={s.removePhotoBadge}>
                  <X size={11} color={COLORS.white} />
                </TouchableOpacity>
              )}
            </View>
            {photoLocked && (
              <Text style={s.photoLockedText}>Photo locked until {unlockDate}</Text>
            )}
            <Text style={s.heroName}>{name}</Text>
            <Text style={s.heroDept}>{profile?.department || 'Student'}</Text>
            <View style={s.idPill}>
              <Text style={s.idPillText}>{profile?.student_id || '—'}</Text>
            </View>
          </View>

          {/* ── Account ── */}
          <Text style={[s.groupLabel, { color: theme.label }]}>Account</Text>
          <View style={[s.card, { backgroundColor: theme.card }]}>
            <SettingsRow icon={PenLine} iconBg="#EEF0FA" iconColor={COLORS.primary}
              label="Preferred Name" value={profile?.preferred_name || 'Not set'}
              onPress={() => { setPrefName(profile?.preferred_name || ''); setModal('name') }} theme={theme} />
            <SettingsRow icon={User} iconBg="#EEF0FA" iconColor={COLORS.primary}
              label="Student ID" value={profile?.student_id || '—'} theme={theme} />
            <SettingsRow icon={Mail} iconBg="#DBEAFE" iconColor="#3B82F6"
              label="Email" value={profile?.email || '—'} theme={theme} />
            <SettingsRow icon={Key} iconBg="#FEF3C7" iconColor="#D97706"
              label="Change Password" value="Send reset link to email"
              onPress={() => setModal('password')} last theme={theme} />
          </View>

          {/* ── Institutional Details ── */}
          <Text style={[s.groupLabel, { color: theme.label }]}>Institutional Details</Text>
          <View style={[s.card, { backgroundColor: theme.card }]}>
            <SettingsRow icon={BookOpen} iconBg="#F0FDF4" iconColor="#10B981"
              label="Department" value={profile?.department || '—'} theme={theme} />
            <SettingsRow icon={ShieldCheck} iconBg={isActive ? '#F0FDF4' : '#FEE2E2'} iconColor={isActive ? '#10B981' : COLORS.red}
              label="Account Status" value={profile?.status || 'ACTIVE'}
              valueColor={isActive ? '#10B981' : COLORS.red} theme={theme} />
            <SettingsRow
              icon={TriangleAlert}
              iconBg={strikes >= 2 ? '#FEE2E2' : strikes === 1 ? '#FEF3C7' : '#F3F4F6'}
              iconColor={strikes >= 2 ? COLORS.red : strikes === 1 ? '#F59E0B' : COLORS.gray400}
              label="Strike Count" value={`${strikes} / 3`}
              valueColor={strikes >= 2 ? COLORS.red : strikes === 1 ? '#F59E0B' : undefined}
              theme={theme} />
            <SettingsRow
              icon={Scale}
              iconBg={pendingAppeal ? '#FEF3C7' : '#EEF0FA'} iconColor={pendingAppeal ? '#D97706' : COLORS.primary}
              label="Appeal Strikes"
              value={pendingAppeal ? 'Appeal pending review' : strikes > 0 ? 'Tap to request a reset' : 'No active strikes'}
              valueColor={pendingAppeal ? '#D97706' : undefined}
              onPress={() => setModal('appeal')} last theme={theme} />
          </View>

          {/* ── Appearance + Recovery in a row ── */}
          <Text style={[s.groupLabel, { color: theme.label }]}>Preferences</Text>
          <View style={[s.card, { backgroundColor: theme.card }]}>
            <View style={[s.row, { paddingBottom: 10, borderBottomWidth: 0 }]}>
              <View style={[s.rowIcon, { backgroundColor: theme.type === 'dark' ? '#312E5C' : '#FEF3C7' }]}>
                {theme.type === 'dark' ? <Moon size={15} color="#A78BFA" /> : <Sun size={15} color="#F59E0B" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowLabel, { color: theme.text }]}>Appearance</Text>
                <Text style={s.rowValue}>{current.charAt(0).toUpperCase() + current.slice(1)} mode active</Text>
              </View>
            </View>

            <View style={s.themeGrid}>
              {[
                { id: 'light', label: 'Light', icon: Sun, color: '#F59E0B' },
                { id: 'dark', label: 'Dark', icon: Moon, color: '#A78BFA' },
              ].map(t => (
                <TouchableOpacity
                  key={t.id}
                  onPress={() => setTheme(t.id)}
                  style={[
                    s.themeBtn,
                    { backgroundColor: theme.input, borderColor: current === t.id ? COLORS.primary : theme.inputBorder },
                    current === t.id && { borderWidth: 2 }
                  ]}
                  activeOpacity={0.7}
                >
                  <t.icon size={16} color={current === t.id ? COLORS.primary : t.color} />
                  <Text style={[s.themeBtnText, { color: current === t.id ? COLORS.primary : theme.textSub }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <SettingsRow icon={Lock} iconBg="#FEE2E2" iconColor="#EF4444"
              label="Account Recovery"
              value={hasRecovery ? profile.recovery_email : 'Not configured — tap to set up'}
              valueColor={hasRecovery ? undefined : COLORS.red}
              onPress={openRecovery} last theme={theme} />
          </View>

          {/* ── Resources ── */}
          <Text style={[s.groupLabel, { color: theme.label }]}>Resources</Text>
          <View style={[s.card, { backgroundColor: theme.card }]}>
            <SettingsRow icon={FileText} iconBg="#DBEAFE" iconColor="#3B82F6"
              label="Guide & Rules" value="Booking and facility guidelines"
              onPress={() => setModal('guide')} theme={theme} />
            <SettingsRow icon={Monitor} iconBg="#F0FDF4" iconColor="#10B981"
              label="Cyberspace Guide" value="Digital resources & access guide"
              onPress={() => setModal('cyber')} last theme={theme} />
          </View>

          {/* ── Log out ── */}
          <View style={[s.card, s.logoutCard, { backgroundColor: theme.card }]}>
            <TouchableOpacity onPress={handleLogout} activeOpacity={0.7} style={s.logoutRow}>
              <View style={[s.rowIcon, { backgroundColor: '#FEE2E2' }]}>
                <LogOut size={15} color={COLORS.red} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.logoutLabel}>Log Out</Text>
                <Text style={s.rowValue}>End your current session</Text>
              </View>
              <ChevronRight size={15} color={COLORS.gray300} />
            </TouchableOpacity>
          </View>

          {/* ── Footer ── */}
          <View style={s.footerWrap}>
            <Text style={[s.footerSub, { color: theme.textMuted }]}>LCspace v1.0</Text>
            <Text style={[s.footerSub, { color: theme.textMuted }]}>Learning Commons Space · USPF</Text>
          </View>
        </ScrollView>

        {/* ── Preferred Name — Half-screen sheet ── */}
        <Modal visible={modal === 'name'} transparent animationType="slide" onRequestClose={closeModal}>
          <View style={s.overlay}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeModal} activeOpacity={1} />
            <View style={[s.sheet, { backgroundColor: theme.modal, maxHeight: SHEET_MAX }]}>
              <View style={[s.handle, { backgroundColor: theme.cardBorder }]} />
              <Text style={[s.sheetTitle, { color: theme.text }]}>Preferred Name</Text>
              <Text style={[s.sheetHint, { color: theme.textMuted }]}>
                This name is used in greetings. It does not change your official name on record.
              </Text>
              <Text style={[s.inputLabel, { color: theme.textSub }]}>Display Name</Text>
              <TextInput
                style={[s.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                value={prefName}
                onChangeText={setPrefName}
                placeholder="e.g. Jhon"
                placeholderTextColor={COLORS.gray400}
                autoFocus
                maxLength={40}
              />
              <TouchableOpacity onPress={savePreferredName} style={s.saveBtn} disabled={savingName} activeOpacity={0.85}>
                {savingName
                  ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.saveBtnText, { marginLeft: 6 }]}>Saving…</Text></>
                  : <><Check size={16} color={COLORS.primary} /><Text style={s.saveBtnText}>Save Name</Text></>
                }
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Appeal Strikes — Half-screen sheet ── */}
        <Modal visible={modal === 'appeal'} transparent animationType="slide" onRequestClose={closeModal}>
          <View style={s.overlay}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeModal} activeOpacity={1} />
            <View style={[s.sheet, { backgroundColor: theme.modal, maxHeight: SHEET_MAX }]}>
              <View style={[s.handle, { backgroundColor: theme.cardBorder }]} />

              {/* ── State 1: Clean record ── */}
              {strikes === 0 && (
                <View style={s.appealCenter}>
                  <View style={[s.appealIconInner, { backgroundColor: '#ECFDF5', width: 68, height: 68, borderRadius: 34 }]}>
                    <ShieldCheck size={30} color="#10B981" />
                  </View>
                  <Text style={[s.appealHeading, { color: theme.text, marginTop: 14 }]}>Clean Record</Text>
                  <Text style={[s.appealSub, { color: theme.textMuted }]}>
                    You have <Text style={{ fontWeight: '700', color: '#10B981' }}>0 active strikes</Text>. Appeals can only be filed when you have at least one active strike.
                  </Text>
                  <View style={[s.appealBadge, { backgroundColor: '#ECFDF5', marginBottom: 20 }]}>
                    <ShieldCheck size={13} color="#10B981" />
                    <Text style={[s.appealBadgeText, { color: '#10B981' }]}>Account in good standing</Text>
                  </View>
                  <TouchableOpacity onPress={closeModal} style={s.appealDoneBtn} activeOpacity={0.85}>
                    <Check size={15} color={COLORS.primary} />
                    <Text style={s.saveBtnText}>Got it</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* ── State 2: Appeal pending review ── */}
              {strikes > 0 && pendingAppeal && (
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <View style={s.appealCenter}>
                    <View style={[s.appealIconInner, { backgroundColor: '#FEF3C7', width: 68, height: 68, borderRadius: 34 }]}>
                      <Clock size={28} color="#F59E0B" />
                    </View>
                    <Text style={[s.appealHeading, { color: theme.text, marginTop: 14 }]}>Under Review</Text>
                    <Text style={[s.appealSub, { color: theme.textMuted }]}>
                      The administration is reviewing your appeal. You'll be notified via Mail once a decision is made.
                    </Text>
                    <View style={[s.appealBadge, { backgroundColor: '#FEF3C7' }]}>
                      <Clock size={13} color="#F59E0B" />
                      <Text style={[s.appealBadgeText, { color: '#92400E' }]}>Awaiting admin decision</Text>
                    </View>
                  </View>
                  <View style={[s.appealReasonCard, { backgroundColor: theme.input, borderColor: theme.inputBorder, marginTop: 14 }]}>
                    <Text style={s.appealReasonLabel}>YOUR SUBMITTED REASON</Text>
                    <Text style={[s.appealReasonText, { color: theme.textSub }]}>"{pendingAppeal.reason}"</Text>
                  </View>
                  <TouchableOpacity onPress={closeModal} style={[s.appealDoneBtn, { marginTop: 16 }]} activeOpacity={0.85}>
                    <Text style={s.saveBtnText}>Close</Text>
                  </TouchableOpacity>
                </ScrollView>
              )}

              {/* ── State 3: Submit appeal ── */}
              {strikes > 0 && !pendingAppeal && (
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <View style={s.appealStrikeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.appealHeading, { color: theme.text, textAlign: 'left', fontSize: 16, marginBottom: 2 }]}>Appeal Strikes</Text>
                      <Text style={[s.appealSub, { color: theme.textMuted, textAlign: 'left', fontSize: 12, marginBottom: 0 }]}>Submit one appeal at a time. Be honest and specific.</Text>
                    </View>
                    <View style={[s.appealStrikeBadge, { backgroundColor: strikes >= 2 ? '#FEE2E2' : '#FEF3C7' }]}>
                      <TriangleAlert size={12} color={strikes >= 2 ? '#B91C1C' : '#92400E'} />
                      <Text style={[s.appealStrikeBadgeText, { color: strikes >= 2 ? '#B91C1C' : '#92400E' }]}>{strikes}/3</Text>
                    </View>
                  </View>
                  <View style={[s.appealDots, { marginBottom: 14 }]}>
                    {[0, 1, 2].map(i => (
                      <View key={i} style={[s.appealDot, { backgroundColor: i < strikes ? (strikes >= 2 ? '#EF4444' : '#F59E0B') : theme.cardBorder || COLORS.gray100 }]} />
                    ))}
                    <Text style={[s.appealDotsLabel, { color: theme.textMuted, fontSize: 11 }]}>
                      {strikes >= 3 ? 'Account at risk' : `${3 - strikes} strike${3 - strikes !== 1 ? 's' : ''} remaining`}
                    </Text>
                  </View>
                  <Text style={[s.inputLabel, { color: theme.textSub }]}>Reason for Appeal</Text>
                  <TextInput
                    style={[s.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text, height: 96, textAlignVertical: 'top' }]}
                    value={appealReason}
                    onChangeText={v => setAppealReason(v.slice(0, 500))}
                    placeholder="Explain why your strikes should be removed…"
                    placeholderTextColor={COLORS.gray400}
                    multiline
                  />
                  <Text style={[s.appealCharCount, { color: theme.textMuted }]}>{appealReason.length}/500</Text>
                  <TouchableOpacity
                    onPress={submitAppeal}
                    style={[s.appealDoneBtn, (submittingAppeal || !appealReason.trim()) && { opacity: 0.45 }]}
                    disabled={submittingAppeal || !appealReason.trim()}
                    activeOpacity={0.85}
                  >
                    {submittingAppeal
                      ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.saveBtnText, { marginLeft: 6 }]}>Submitting…</Text></>
                      : <><Scale size={15} color={COLORS.primary} /><Text style={s.saveBtnText}>Submit Appeal</Text></>
                    }
                  </TouchableOpacity>
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>

        {/* ── Change Password — Half-screen sheet ── */}
        <Modal visible={modal === 'password'} transparent animationType="slide" onRequestClose={closeModal}>
          <View style={s.overlay}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeModal} activeOpacity={1} />
            <View style={[s.sheet, { backgroundColor: theme.modal, maxHeight: SHEET_MAX }]}>
              <View style={[s.handle, { backgroundColor: theme.cardBorder }]} />
              {resetSent ? (
                <View style={s.successBox}>
                  <View style={s.successIcon}><Check size={24} color={COLORS.white} /></View>
                  <Text style={[s.sheetTitle, { color: theme.text, textAlign: 'center' }]}>Reset Link Sent!</Text>
                  <Text style={[s.sheetHint, { color: theme.textMuted, textAlign: 'center' }]}>
                    Check your inbox at {profile?.email} for a password reset link.
                  </Text>
                  <TouchableOpacity onPress={closeModal} style={s.saveBtn}>
                    <Text style={s.saveBtnText}>Done</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <Text style={[s.sheetTitle, { color: theme.text }]}>Change Password</Text>
                  <Text style={[s.sheetHint, { color: theme.textMuted }]}>
                    A reset link will be sent to your institutional email address.
                  </Text>
                  <View style={[s.emailPreview, { backgroundColor: theme.metaChip }]}>
                    <Mail size={14} color={COLORS.primary} />
                    <Text style={s.emailPreviewText}>{profile?.email || '—'}</Text>
                  </View>
                  <TouchableOpacity onPress={handlePasswordReset} style={s.saveBtn} disabled={sendingReset} activeOpacity={0.85}>
                    {sendingReset
                      ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.saveBtnText, { marginLeft: 6 }]}>Sending…</Text></>
                      : <><Key size={16} color={COLORS.primary} /><Text style={s.saveBtnText}>Send Reset Link</Text></>
                    }
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </Modal>

        {/* ── Account Recovery — Half-screen sheet ── */}
        <Modal visible={modal === 'recovery'} transparent animationType="slide" onRequestClose={closeModal}>
          <View style={s.overlay}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeModal} activeOpacity={1} />
            <View style={[s.sheet, { backgroundColor: theme.modal, maxHeight: SHEET_MAX }]}>
              <View style={[s.handle, { backgroundColor: theme.cardBorder }]} />
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={[s.sheetTitle, { color: theme.text }]}>Account Recovery</Text>
                <Text style={[s.sheetHint, { color: theme.textMuted }]}>
                  Set up recovery details to regain access if you forget your password.
                </Text>

                <Text style={[s.inputLabel, { color: theme.textSub }]}>Recovery Email</Text>
                <TextInput
                  style={[s.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                  value={recoveryEmail}
                  onChangeText={setRecoveryEmail}
                  placeholder="Enter recovery email"
                  placeholderTextColor={COLORS.gray400}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />

                <Text style={[s.inputLabel, { color: theme.textSub }]}>Security Question</Text>
                <TouchableOpacity
                  onPress={() => setShowQPicker(true)}
                  style={[s.pickerBtn, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}
                  activeOpacity={0.8}
                >
                  <Text style={[s.pickerText, { color: securityQuestion ? theme.text : COLORS.gray400 }]} numberOfLines={1}>
                    {securityQuestion || 'Select a security question'}
                  </Text>
                  <ChevronDown size={16} color={COLORS.gray400} />
                </TouchableOpacity>

                <Text style={[s.inputLabel, { color: theme.textSub }]}>Answer / PIN Code</Text>
                <TextInput
                  style={[s.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                  value={recoveryAnswer}
                  onChangeText={setRecoveryAnswer}
                  placeholder={securityQuestion === 'Enter your own recovery PIN code' ? 'Enter your PIN code' : 'Enter your answer'}
                  placeholderTextColor={COLORS.gray400}
                />

                <TouchableOpacity onPress={saveRecovery} style={s.saveBtn} disabled={savingRecovery} activeOpacity={0.85}>
                  {savingRecovery
                    ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.saveBtnText, { marginLeft: 6 }]}>Saving…</Text></>
                    : <><Shield size={16} color={COLORS.primary} /><Text style={s.saveBtnText}>Save Recovery Details</Text></>
                  }
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* ── Security Question Picker — transparent overlay ── */}
        <Modal visible={showQPicker} transparent animationType="fade" onRequestClose={() => setShowQPicker(false)}>
          <View style={s.qPickerOverlay}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setShowQPicker(false)} activeOpacity={1} />
            <View style={[s.qPickerCard, { backgroundColor: theme.modal }]}>
              <Text style={[s.qPickerTitle, { color: theme.text }]}>Select a Security Question</Text>
              {SECURITY_QUESTIONS.map(q => (
                <TouchableOpacity
                  key={q}
                  onPress={() => { setSecurityQuestion(q); setShowQPicker(false) }}
                  style={[s.qOption, { borderBottomColor: theme.cardBorder }]}
                  activeOpacity={0.7}
                >
                  <Text style={[s.qOptionText, { color: theme.text }, securityQuestion === q && s.qOptionActive]} numberOfLines={2}>
                    {q}
                  </Text>
                  {securityQuestion === q && <Check size={15} color={COLORS.primary} />}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </Modal>

        {/* ── Guide & Rules — Full pageSheet ── */}
        <Modal visible={modal === 'guide'} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeModal}>
          <SafeAreaView style={[s.fullModal, { backgroundColor: theme.modal }]}>
            <ModalHeader title="Guide & Rules" onClose={closeModal} theme={theme} />
            <ScrollView contentContainerStyle={s.modalBody} showsVerticalScrollIndicator={false}>
              {GUIDE_SECTIONS.map(section => (
                <InfoSection key={section.title} section={section} theme={theme} />
              ))}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        {/* ── Cyberspace — Full pageSheet ── */}
        <Modal visible={modal === 'cyber'} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeModal}>
          <SafeAreaView style={[s.fullModal, { backgroundColor: theme.modal }]}>
            <ModalHeader title="Cyberspace" onClose={closeModal} theme={theme} />
            <ScrollView contentContainerStyle={s.modalBody} showsVerticalScrollIndicator={false}>
              <View style={[s.cyberHero, { backgroundColor: theme.metaChip }]}>
                <Monitor size={32} color={COLORS.primary} />
                <Text style={[s.cyberHeroTitle, { color: COLORS.primary }]}>Digital Learning Hub</Text>
                <Text style={[s.cyberHeroDesc, { color: theme.textSub }]}>
                  LCspace provides cutting-edge digital infrastructure to support collaborative and digital-first learning at USPF.
                </Text>
              </View>
              {CYBER_SECTIONS.map(section => (
                <InfoSection key={section.title} section={section} theme={theme} />
              ))}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        {/* Shared, app-wide alert dialog */}
        <AlertHost />
      </SafeAreaView>
    </View>
  )
}

// ── Reusable components ──────────────────────────────────────────

function SettingsRow({ icon: Icon, iconBg, iconColor, label, value, onPress, last, valueColor, theme }) {
  const content = (
    <View style={[s.row, { borderBottomColor: theme?.cardBorder || COLORS.gray100 }, last && s.rowLast]}>
      <View style={[s.rowIcon, { backgroundColor: iconBg }]}>
        <Icon size={15} color={iconColor || COLORS.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.rowLabel, { color: theme?.text || COLORS.gray900 }]}>{label}</Text>
        <Text style={[s.rowValue, valueColor && { color: valueColor }]} numberOfLines={1}>{value}</Text>
      </View>
      {onPress && <ChevronRight size={15} color={COLORS.gray300} />}
    </View>
  )
  return onPress
    ? <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{content}</TouchableOpacity>
    : content
}

function ModalHeader({ title, onClose, theme }) {
  return (
    <View style={[s.modalHeader, { borderBottomColor: theme?.cardBorder || COLORS.gray100 }]}>
      <Text style={[s.modalTitle, { color: theme?.text || COLORS.gray900 }]}>{title}</Text>
      <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: theme?.chipBg || COLORS.gray100 }]}>
        <X size={18} color={theme?.textSub || COLORS.gray500} />
      </TouchableOpacity>
    </View>
  )
}

function InfoSection({ section, theme }) {
  const SectionIcon = section.icon
  return (
    <View style={[s.infoSection, { backgroundColor: theme?.card || COLORS.white }]}>
      <View style={s.infoSectionHeader}>
        <View style={[s.infoSectionIcon, { backgroundColor: theme?.metaChip || '#EEF0FA' }]}>
          <SectionIcon size={14} color={COLORS.primary} />
        </View>
        <Text style={[s.infoSectionTitle, { color: theme?.text || COLORS.gray900 }]}>{section.title}</Text>
      </View>
      {section.items.map((item, i) => (
        <View key={i} style={s.infoItem}>
          <View style={s.infoBullet} />
          <Text style={[s.infoItemText, { color: theme?.textSub || COLORS.gray600 }]}>{item}</Text>
        </View>
      ))}
    </View>
  )
}

// ── Styles ───────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.primary },
  scroll: { flex: 1 },
  body: { paddingBottom: 110 },

  // Hero
  hero: { backgroundColor: COLORS.primary, alignItems: 'center', paddingTop: 8, paddingBottom: 18, paddingHorizontal: 20 },
  appLabel: { fontSize: 10, ...FONTS.bold, color: 'rgba(245,201,0,0.65)', letterSpacing: 1.8, marginBottom: 10, alignSelf: 'flex-start' },
  avatarWrap: { position: 'relative', marginBottom: 4 },
  avatar: { width: 76, height: 76, borderRadius: 38, borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.22)' },
  statusDot: { position: 'absolute', bottom: 2, right: 2, width: 15, height: 15, borderRadius: 7.5, borderWidth: 2, borderColor: COLORS.primary },
  cameraBadge: { position: 'absolute', bottom: 2, left: 2, width: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.primary, borderWidth: 2, borderColor: COLORS.white, justifyContent: 'center', alignItems: 'center' },
  removePhotoBadge: { position: 'absolute', top: -2, right: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.red, borderWidth: 2, borderColor: COLORS.primary, justifyContent: 'center', alignItems: 'center' },
  photoLockedText: { fontSize: 10, color: 'rgba(255,255,255,0.45)', ...FONTS.medium, marginBottom: 4, marginTop: 2 },
  heroName: { fontSize: 18, ...FONTS.extrabold, color: COLORS.white, marginBottom: 2, marginTop: 4 },
  heroDept: { fontSize: 11, color: 'rgba(255,255,255,0.45)', ...FONTS.medium, marginBottom: 8 },
  idPill: { backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 16 },
  idPillText: { fontSize: 11, ...FONTS.bold, color: 'rgba(255,255,255,0.65)', fontFamily: 'monospace' },

  // Section groups
  groupLabel: { fontSize: 11, ...FONTS.bold, textTransform: 'uppercase', letterSpacing: 0.9, marginHorizontal: 16, marginTop: 20, marginBottom: 8 },
  card: { borderRadius: 18, marginHorizontal: 16, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 3 },

  // Row
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  rowLabel: { fontSize: 13, ...FONTS.semibold, marginBottom: 1 },
  rowValue: { fontSize: 12, color: COLORS.gray400 },

  // Custom alert modal
  alertBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36 },
  alertCard: { width: '100%', maxWidth: 340, borderRadius: 22, paddingVertical: 22, paddingHorizontal: 22, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 14 },
  alertTitle: { fontSize: 17, ...FONTS.extrabold, marginBottom: 6, textAlign: 'center' },
  alertMessage: { fontSize: 13, ...FONTS.regular, lineHeight: 19, marginBottom: 18, textAlign: 'center' },
  alertButtons: { flexDirection: 'row', gap: 10 },
  alertButtonsStacked: { flexDirection: 'column' },
  alertBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  alertBtnText: { fontSize: 13, ...FONTS.bold },

  // Log out
  logoutCard: { marginTop: 22 },
  logoutRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  logoutLabel: { fontSize: 13, ...FONTS.semibold, color: COLORS.red, marginBottom: 1 },

  // Footer
  footerWrap: { alignItems: 'center', marginTop: 26, gap: 4 },
  footerSub: { fontSize: 11, ...FONTS.medium },

  // ── Half-screen sheet ──
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 36 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 18 },
  sheetTitle: { fontSize: 18, ...FONTS.extrabold, marginBottom: 6 },
  sheetHint: { fontSize: 13, lineHeight: 19, marginBottom: 18 },

  inputLabel: { fontSize: 13, ...FONTS.semibold, marginBottom: 8 },
  input: { borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, fontSize: 14, marginBottom: 16 },
  saveBtn: { backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 15, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 4 },
  saveBtnText: { fontSize: 15, ...FONTS.bold, color: COLORS.primary },

  // Picker button
  pickerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, marginBottom: 16 },
  pickerText: { fontSize: 14, flex: 1, marginRight: 8 },

  // Question picker overlay
  qPickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', paddingHorizontal: 20 },
  qPickerCard: { borderRadius: 20, padding: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 10 },
  qPickerTitle: { fontSize: 16, ...FONTS.bold, marginBottom: 14 },
  qOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, gap: 10 },
  qOptionText: { fontSize: 13, flex: 1, lineHeight: 19 },
  qOptionActive: { ...FONTS.bold, color: COLORS.primary },

  // Change password success
  successBox: { alignItems: 'center', paddingVertical: 8, gap: 10 },
  successIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: COLORS.emerald, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },

  // Email preview
  emailPreview: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, padding: 14, marginBottom: 20 },
  emailPreviewText: { fontSize: 13, ...FONTS.semibold, color: COLORS.primary },

  // Full-screen modals (guide / cyber)
  fullModal: { flex: 1 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 18, borderBottomWidth: 1 },
  modalTitle: { fontSize: 18, ...FONTS.extrabold },
  closeBtn: { width: 34, height: 34, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  modalBody: { padding: 20, paddingBottom: 40 },

  // Info sections
  infoSection: { borderRadius: 16, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  infoSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  infoSectionIcon: { width: 32, height: 32, borderRadius: 9, justifyContent: 'center', alignItems: 'center' },
  infoSectionTitle: { fontSize: 14, ...FONTS.bold },
  infoItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  infoBullet: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: COLORS.primary, marginTop: 7, flexShrink: 0 },
  infoItemText: { fontSize: 13, lineHeight: 19, flex: 1 },

  // Cyberspace hero
  cyberHero: { borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 16, gap: 8 },
  cyberHeroTitle: { fontSize: 17, ...FONTS.extrabold },
  cyberHeroDesc: { fontSize: 13, textAlign: 'center', lineHeight: 19 },

  // Appeal sheet
  appealDoneBtn: { backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 14, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, width: '100%' },
  appealCenter: { alignItems: 'center', paddingTop: 4, paddingBottom: 8 },
  appealIconRing: { width: 76, height: 76, borderRadius: 38, backgroundColor: 'rgba(0,0,0,0.04)', justifyContent: 'center', alignItems: 'center', marginBottom: 14 },
  appealIconInner: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center' },
  appealHeading: { fontSize: 18, ...FONTS.extrabold, textAlign: 'center', marginBottom: 8 },
  appealSub: { fontSize: 13, lineHeight: 20, textAlign: 'center', marginBottom: 14, paddingHorizontal: 8 },
  appealBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
  appealBadgeText: { fontSize: 12, ...FONTS.semibold },
  appealReasonCard: { borderRadius: 14, padding: 14, borderWidth: 1, marginTop: 4 },
  appealReasonLabel: { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6 },
  appealReasonText: { fontSize: 13, lineHeight: 20, fontStyle: 'italic' },
  appealStrikeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  appealStrikeBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 },
  appealStrikeBadgeText: { fontSize: 13, ...FONTS.extrabold },
  appealDots: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  appealDot: { width: 10, height: 10, borderRadius: 5 },
  appealDotsLabel: { fontSize: 11, flex: 1 },
  appealCharCount: { fontSize: 11, textAlign: 'right', marginTop: -10, marginBottom: 14 },

  themeGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  themeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  themeBtnText: {
    fontSize: 12,
    ...FONTS.bold,
  },
})
