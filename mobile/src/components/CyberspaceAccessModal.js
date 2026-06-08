import { useState, useEffect } from 'react'
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto'
import { Lock, Clock, Timer, AlertCircle, CircleCheckBig, X } from 'lucide-react-native'
import { COLORS, FONTS } from '../lib/theme'

// Parse "8:00 AM – 10:00 AM" into { startMs, endMs } against booking_date
function parseTimeSlot(slotStr, bookingDate) {
  if (!slotStr) return null
  const parts = slotStr.replace(/–|—|‒/g, '-').split('-').map(s => s.trim())
  if (parts.length < 2) return null
  const toMs = (str) => {
    const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i)
    if (!m) return null
    let h = parseInt(m[1], 10); const min = parseInt(m[2], 10)
    const period = m[3].toUpperCase()
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    const d = bookingDate ? new Date(bookingDate + 'T00:00') : new Date()
    d.setHours(h, min, 0, 0)
    return d.getTime()
  }
  const startMs = toMs(parts[0]); const endMs = toMs(parts[1])
  if (!startMs || !endMs) return null
  return { startMs, endMs }
}

// state: 'no_booking' | 'not_confirmed' | 'not_checked_in' | 'too_early' | 'expired' | 'needs_password'
function resolveState(booking) {
  if (!booking) return 'no_booking'
  const today = new Date().toISOString().split('T')[0]
  if (booking.booking_date !== today) return 'no_booking'
  if (booking.status === 'Pending') return 'not_confirmed'
  if (booking.status === 'Confirmed') return 'not_checked_in'
  if (booking.status === 'Checked-In' || booking.status === 'Active') {
    const slot = parseTimeSlot(booking.time, booking.booking_date)
    if (slot) {
      const now = Date.now()
      if (now < slot.startMs) return 'too_early'
      if (now > slot.endMs)   return 'expired'
    }
    return 'needs_password'
  }
  return 'no_booking'
}

export default function CyberspaceAccessModal({ visible, booking, onClose, onEnter }) {
  const [pwInput, setPwInput]   = useState('')
  const [pwError, setPwError]   = useState('')
  const [verifying, setVerifying] = useState(false)

  useEffect(() => { if (visible) { setPwInput(''); setPwError('') } }, [visible])

  const state = resolveState(booking)

  async function verify() {
    if (!pwInput.trim() || !booking?.docId) return
    setVerifying(true); setPwError('')
    try {
      const [snap, inputHash] = await Promise.all([
        getDoc(doc(db, 'bookings', booking.docId)),
        digestStringAsync(CryptoDigestAlgorithm.SHA256, pwInput.trim().toUpperCase()),
      ])
      const data = snap.data()
      if (!data?.cyberspace_token_hash) {
        setPwError('No access code found for your booking. Please contact the admin desk.')
      } else if (data.cyberspace_token_hash === inputHash) {
        onEnter?.(booking.docId)
      } else {
        setPwError('Incorrect code. Please visit the admin desk to get your personal access code.')
      }
    } catch {
      setPwError('Unable to verify. Please check your connection.')
    }
    setVerifying(false)
  }

  const variants = {
    too_early:      { Icon: Clock,          color: '#F59E0B', badge: 'Not Yet Available',   title: 'Session Not Started Yet',         body: 'Your reserved time slot hasn\'t started. Come back when it begins.' },
    expired:        { Icon: Timer,          color: '#EF4444', badge: 'Session Expired',     title: 'Your 2-Hour Session Has Ended',   body: 'Your reserved time slot has already passed. Please make a new reservation for a future slot.' },
    no_booking:     { Icon: Lock,           color: COLORS.primary, badge: 'No Reservation',  title: 'Access Restricted',               body: 'You need an admin-confirmed reservation for today to access Cyberspace.' },
    not_confirmed:  { Icon: AlertCircle,    color: '#3B82F6', badge: 'Pending Approval',    title: 'Awaiting Admin Confirmation',     body: 'Your reservation is still Pending. Cyberspace access is only granted after an admin confirms your booking.' },
    not_checked_in: { Icon: CircleCheckBig,   color: '#F97316', badge: 'Check-In Required',   title: 'Please Visit the Admin Desk',     body: 'Your booking is confirmed — but you need to check in with the admin desk first before accessing Cyberspace.' },
    needs_password: { Icon: Lock,           color: COLORS.primary, badge: 'Access Code Required', title: 'Enter Your Personal Access Code', body: 'Visit the admin desk and ask for your access code. Each student has a unique code — the admin will read it out to you.' },
  }
  const v = variants[state]

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <TouchableOpacity onPress={onClose} style={s.closeBtn} hitSlop={10}>
            <X size={18} color={COLORS.gray500} />
          </TouchableOpacity>

          <View style={[s.iconWrap, { backgroundColor: v.color + '15' }]}>
            <v.Icon size={32} color={v.color} />
          </View>

          <View style={[s.badge, { backgroundColor: v.color + '15' }]}>
            <Text style={[s.badgeText, { color: v.color }]}>{v.badge}</Text>
          </View>

          <Text style={s.title}>{v.title}</Text>
          {!!v.body && <Text style={s.body}>{v.body}</Text>}

          {state === 'needs_password' && (
            <>
              <TextInput
                style={s.input}
                placeholder="Enter access code"
                placeholderTextColor={COLORS.gray400}
                value={pwInput}
                onChangeText={t => { setPwInput(t.toUpperCase()); if (pwError) setPwError('') }}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!verifying}
              />
              {!!pwError && <Text style={s.error}>{pwError}</Text>}
              <TouchableOpacity onPress={verify} disabled={verifying || !pwInput.trim()} style={[s.primaryBtn, (!pwInput.trim() || verifying) && { opacity: 0.5 }]}>
                {verifying ? <><ActivityIndicator color={COLORS.white} /><Text style={[s.primaryBtnText, { marginLeft: 8 }]}>Verifying…</Text></> : <Text style={s.primaryBtnText}>Enter Cyberspace</Text>}
              </TouchableOpacity>
            </>
          )}

          {state !== 'needs_password' && (
            <TouchableOpacity onPress={onClose} style={s.primaryBtn}>
              <Text style={s.primaryBtnText}>OK</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28 },
  card:         { width: '100%', maxWidth: 360, backgroundColor: COLORS.white, borderRadius: 22, padding: 24, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 14 },
  closeBtn:     { position: 'absolute', top: 12, right: 12, padding: 4 },
  iconWrap:     { width: 64, height: 64, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  badge:        { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, marginBottom: 10 },
  badgeText:    { fontSize: 11, ...FONTS.bold, letterSpacing: 0.3 },
  title:        { fontSize: 17, ...FONTS.extrabold, color: COLORS.gray900, textAlign: 'center', marginBottom: 6 },
  body:         { fontSize: 13, color: COLORS.gray500, textAlign: 'center', lineHeight: 19, marginBottom: 16, ...FONTS.regular },
  input:        { width: '100%', height: 48, backgroundColor: COLORS.gray50, borderRadius: 12, borderWidth: 1, borderColor: COLORS.gray200, paddingHorizontal: 14, fontSize: 15, ...FONTS.bold, color: COLORS.primary, letterSpacing: 2, textAlign: 'center', marginBottom: 8 },
  error:        { color: COLORS.red, fontSize: 12, marginBottom: 8, textAlign: 'center', ...FONTS.medium },
  primaryBtn:   { width: '100%', height: 48, borderRadius: 12, backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center', marginTop: 8 },
  primaryBtnText:{ color: COLORS.white, fontSize: 14, ...FONTS.bold },
})
