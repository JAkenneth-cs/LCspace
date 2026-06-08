import { Fragment, useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, StatusBar, Modal } from 'react-native'
import { collection, addDoc, getDocs, query, where, serverTimestamp, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { COLORS, FONTS } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Calendar, Users, Clock, ChevronRight, Check, Download, House, ChevronLeft } from 'lucide-react-native'
import { useNavigation } from '@react-navigation/native'
import Svg, { Rect, Line, Circle, Defs, RadialGradient, Stop } from 'react-native-svg'

function SingleDoorIcon({ size = 20, color = '#262367' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="4" y="2" width="16" height="20" rx="1.5" stroke={color} strokeWidth="2" />
      <Circle cx="14.5" cy="12" r="1.2" fill={color} />
    </Svg>
  )
}

function DoubleDoorIcon({ size = 20, color = '#262367' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="2" y="2" width="20" height="20" rx="1.5" stroke={color} strokeWidth="2" />
      <Line x1="12" y1="2" x2="12" y2="22" stroke={color} strokeWidth="2" />
      <Circle cx="9.5" cy="12" r="1.2" fill={color} />
      <Circle cx="14.5" cy="12" r="1.2" fill={color} />
    </Svg>
  )
}
import ViewShot from 'react-native-view-shot'
import BookingReceipt from '../components/BookingReceipt'
import * as MediaLibrary from 'expo-media-library'
import * as Sharing from 'expo-sharing'
import { useAlert } from '../components/AlertModal'
import { sanitizeText } from '../lib/validation'
import { checkRateLimit, resetRateLimit, formatRetryAfter } from '../lib/rateLimit'

const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const ROOMS = [
  {
    id: 'collab-001', name: 'Collaborative Room 1', capacity: '4 – 6 people', type: 'Collaborative', icon: SingleDoorIcon,
    desc: 'An enclosed study room ideal for focused group discussions and academic sessions.',
    features: ['Whiteboard', 'Power Outlets', 'High-speed WiFi'],
  },
  {
    id: 'collab-002', name: 'Collaborative Room 2', capacity: '4 – 6 people', type: 'Collaborative', icon: SingleDoorIcon,
    desc: 'A quiet, enclosed space equipped for collaborative work and group presentations.',
    features: ['Whiteboard', 'Power Outlets', 'High-speed WiFi'],
  },
  {
    id: 'makers-001', name: "Innovative Makers' Space 1", capacity: '6 – 8 people', type: 'Makers', icon: DoubleDoorIcon,
    desc: 'A creative workshop space designed for hands-on project work and prototyping.',
    features: ['Large Display', 'Charging Stations', 'Air-conditioned', 'High-speed WiFi'],
  },
  {
    id: 'makers-002', name: "Innovative Makers' Space 2", capacity: '6 – 8 people', type: 'Makers', icon: DoubleDoorIcon,
    desc: 'A flexible innovation space for larger teams engaging in creative and technical work.',
    features: ['Large Display', 'Charging Stations', 'Air-conditioned', 'High-speed WiFi'],
  },
]

const TIME_SLOTS = [
  '8:00 AM – 10:00 AM',
  '10:00 AM – 12:00 PM',
  '12:00 PM – 2:00 PM',
  '2:00 PM – 4:00 PM',
]

const STEPS = ['Room', 'Date', 'Time', 'Details', 'Confirm']

export default function ReserveScreen({ profile, route }) {
  const { showAlert, AlertHost } = useAlert()
  const { theme } = useTheme()
  const navigation = useNavigation()
  const [step, setStep] = useState(0)
  const [room, setRoom] = useState(null)
  const [date, setDate] = useState('')
  const [time, setTime] = useState(null)
  const [purpose, setPurpose] = useState('')
  const [groupSize, setGroupSize] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [bookingId, setBookingId] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [previewVisible, setPreviewVisible] = useState(false)
  const [takenSlots, setTakenSlots] = useState([])
  const ticketRef = useRef()

  // Matches the website rule: a slot is bookable until its END time passes.
  // Future dates → always OK; past dates → never; same-day → OK while ongoing.
  function isSlotBookable(slotStr, dateStr) {
    if (!slotStr || !dateStr) return true
    const today = localISO(new Date())
    if (dateStr > today) return true   // future date is always OK
    if (dateStr < today) return false  // past date never OK
    // Same-day — bookable until the slot's END time
    const endPart = slotStr.split('–')[1]?.trim() || slotStr.split(' - ')[1]?.trim()
    const m = endPart?.match(/(\d+):(\d+)\s*(AM|PM)/i)
    if (!m) return true
    let h = parseInt(m[1], 10); const min = parseInt(m[2], 10)
    const period = m[3].toUpperCase()
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    const [y, mon, d] = dateStr.split('-').map(Number)
    const slotEnd = new Date(y, mon - 1, d)
    slotEnd.setHours(h, min, 0, 0)
    return slotEnd.getTime() > Date.now()
  }

  // Deep-link from Home's "Available Facilities" — pre-select the room and jump
  // to the date step. The `ts` param makes each tap a fresh navigation.
  useEffect(() => {
    const rid = route?.params?.roomId
    if (!rid || done) return
    const found = ROOMS.find(r => r.id === rid)
    if (found) { setRoom(found); setStep(1) }
  }, [route?.params?.ts])

  // Live-fetch taken slots whenever we're on the time step with room+date selected
  useEffect(() => {
    if (step !== 2 || !room || !date) { setTakenSlots([]); return }
    const q = query(
      collection(db, 'bookings'),
      where('room_id', '==', room.id),
      where('booking_date', '==', date),
    )
    const SLOT_TAKEN = ['Pending', 'Confirmed', 'Checked-In', 'Active']
    const unsub = onSnapshot(q, snap => {
      setTakenSlots(
        snap.docs
          .map(d => d.data())
          .filter(b => SLOT_TAKEN.includes(b.status))
          .map(b => b.time)
      )
    })
    return unsub
  }, [step, room, date])

  const dates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i)
    return {
      iso: localISO(d),
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
      day: d.getDate(),
      month: d.toLocaleDateString('en-US', { month: 'short' }),
      isToday: i === 0,
    }
  }).filter(d => {
    const day = new Date(d.iso + 'T00:00').getDay()
    return day !== 0 && day !== 6
  })

  async function handleSubmit() {
    const cleanPurpose = sanitizeText(purpose)
    if (!cleanPurpose || cleanPurpose.length < 5) {
      showAlert('Missing', 'Please describe the purpose of your reservation (min 5 characters).')
      return
    }
    if (!isSlotBookable(time, date)) {
      showAlert(
        'Slot Unavailable',
        'This time slot has already ended. Please choose a later slot or a future date.'
      )
      return
    }
    const gs = parseInt(groupSize) || 1
    if (gs < 1 || gs > 8) { showAlert('Invalid', 'Group size must be 1 – 8.'); return }
    const rl = await checkRateLimit('booking')
    if (!rl.allowed) {
      showAlert('Too Many Attempts', `Please wait ${formatRetryAfter(rl.retryAfterMs)} before booking again.`)
      return
    }
    setSubmitting(true)
    try {
      // One reservation per student per day — only active bookings count
      const ACTIVE = ['Pending', 'Confirmed', 'Checked-In', 'Active']
      const daySnap = await getDocs(query(
        collection(db, 'bookings'),
        where('user_id', '==', auth.currentUser.uid),
        where('booking_date', '==', date)
      ))
      if (daySnap.docs.some(d => ACTIVE.includes(d.data().status))) {
        showAlert('Daily Limit', 'You already have a reservation on this date. Only one reservation is allowed per day.')
        setSubmitting(false); return
      }

      const snap = await getDocs(query(
        collection(db, 'bookings'),
        where('room_id', '==', room.id),
        where('booking_date', '==', date),
        where('time', '==', time)
      ))
      const ACTIVE_STATUSES = ['Pending', 'Confirmed', 'Checked-In', 'Active']
      if (snap.docs.some(d => ACTIVE_STATUSES.includes(d.data().status))) {
        showAlert('Slot Taken', 'This slot is already booked. Please choose another.')
        setSubmitting(false); return
      }
      const id = Math.random().toString(36).slice(2, 8).toUpperCase()
      const formattedDate = new Date(date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      await addDoc(collection(db, 'bookings'), {
        id,
        user_id: auth.currentUser.uid,
        student_name: profile?.name || '',
        student_id: profile?.student_id || '',
        room_id: room.id,
        room_name: room.name,
        booking_date: date,
        date: formattedDate,
        time,
        purpose: cleanPurpose,
        group_size: gs,
        status: 'Pending',
        created_at: serverTimestamp(),
      })
      setBookingId(id); setDone(true); resetRateLimit('booking')
    } catch { showAlert('Error', 'Failed to submit booking. Please try again.') }
    setSubmitting(false)
  }

  function reset() {
    setStep(0); setRoom(null); setDate(''); setTime(null)
    setPurpose(''); setGroupSize('1'); setDone(false); setBookingId('')
  }

  async function handleDownload() {
    setDownloading(true)
    try {
      const uri = await ticketRef.current.capture()
      const shareAvailable = await Sharing.isAvailableAsync()
      if (shareAvailable) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Save or share receipt', UTI: 'public.png' })
        setDownloading(false); return
      }
      const { status } = await MediaLibrary.requestPermissionsAsync(true, ['photo'])
      if (status !== 'granted') {
        showAlert('Permission Required', 'Please allow photo access to save the receipt.')
        setDownloading(false); return
      }
      await MediaLibrary.saveToLibraryAsync(uri)
      showAlert('Saved!', 'Receipt has been saved to your photo library.')
    } catch (err) {
      showAlert('Error', `Could not save receipt: ${err?.message || 'unknown error'}`)
    }
    setDownloading(false)
  }

  const fmtDate = iso => iso
    ? new Date(iso + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
    : ''

  // ── Success screen ──
  const successBooking = {
    id: bookingId,
    student_name: profile?.name,
    student_id: profile?.student_id,
    room_name: room?.name,
    booking_date: date,
    time,
    purpose,
    group_size: groupSize,
    status: 'Pending',
  }
  if (done) return (
    <SafeAreaView style={[s.safe, { backgroundColor: theme.bg }]} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.primary} />
      <ScrollView contentContainerStyle={[s.successWrap, { backgroundColor: theme.bg }]} showsVerticalScrollIndicator={false}>

        {/* Success badge */}
        <View style={s.successTop}>
          <View style={s.successCircle}><Check size={26} color={COLORS.white} /></View>
          <Text style={s.successTitle}>Booking Submitted</Text>
          <Text style={s.successSub}>Your booking is under review by admin</Text>
        </View>

        {/* Official receipt (shared with My Bookings) */}
        <BookingReceipt ref={ticketRef} booking={successBooking} />

        {/* Tap to preview hint */}
        <TouchableOpacity onPress={() => setPreviewVisible(true)} style={s.previewHintBtn} activeOpacity={0.7}>
          <Text style={s.previewHintText}>Tap to view full receipt ›</Text>
        </TouchableOpacity>

        {/* Action buttons */}
        <TouchableOpacity onPress={handleDownload} style={s.downloadBtn} disabled={downloading} activeOpacity={0.85}>
          {downloading
            ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.downloadBtnText, { marginLeft: 6 }]}>Downloading…</Text></>
            : <><Download size={15} color={COLORS.primary} /><Text style={s.downloadBtnText}>Download Receipt as PNG</Text></>
          }
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.navigate('Home')}
          style={s.doneBtn}
          activeOpacity={0.85}
        >
          <House size={16} color={COLORS.white} />
          <Text style={s.doneBtnText}>Go Back to Home</Text>
        </TouchableOpacity>

      </ScrollView>

      {/* ── Receipt preview lightbox ── */}
      <Modal visible={previewVisible} transparent animationType="fade" onRequestClose={() => setPreviewVisible(false)}>
        <TouchableOpacity style={s.previewOverlay} activeOpacity={1} onPress={() => setPreviewVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => { }} style={s.previewContent}>

            {/* Receipt (display only) */}
            <BookingReceipt booking={successBooking} />

            {/* Download button */}
            <TouchableOpacity onPress={handleDownload} style={[s.downloadBtn, { marginBottom: 0 }]} disabled={downloading} activeOpacity={0.85}>
              {downloading
                ? <ActivityIndicator color={COLORS.primary} />
                : <><Download size={15} color={COLORS.primary} /><Text style={s.downloadBtnText}>Download Receipt as PNG</Text></>
              }
            </TouchableOpacity>

            <Text style={s.previewDismissHint}>Tap anywhere outside to close</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <AlertHost />
    </SafeAreaView>
  )

  const canNext = !(
    (step === 0 && !room) ||
    (step === 1 && !date) ||
    (step === 2 && !time)
  )

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <SafeAreaView style={[s.safe, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]} edges={['top']}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.type === 'dark' ? theme.bg : COLORS.primary}
        />

        {/* Header */}
        <View style={[s.stepHeader, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]}>
          <Text style={s.headerLabel}>RESERVE A FACILITY</Text>
          <Text style={s.headerTitle}>{STEPS[step]}</Text>
        </View>

        {/* Step indicator — below the navy header */}
        <View style={[s.stepBarWrap, { backgroundColor: theme.card, borderBottomColor: theme.cardBorder }]}>
          <View style={s.stepRow}>
            {STEPS.map((_, i) => (
              <Fragment key={i}>
                {i > 0 && <View style={[s.stepConnector, { backgroundColor: theme.cardBorder }, i <= step && s.stepConnectorDone]} />}
                <View style={[
                  s.stepDot,
                  { backgroundColor: theme.chipBg },
                  i < step && s.stepDotDone,
                  i === step && s.stepDotActive,
                ]}>
                  {i < step
                    ? <Check size={10} color={COLORS.white} />
                    : <Text style={[s.stepNum, { color: theme.textMuted }, i <= step && s.stepNumActive]}>{i + 1}</Text>
                  }
                </View>
              </Fragment>
            ))}
          </View>
        </View>

        <ScrollView style={[s.scroll, { backgroundColor: theme.bg }]} contentContainerStyle={s.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* Step 0 — Room */}
          {step === 0 && (
            <View>
              <Text style={[s.stepHeading, { color: theme.text }]}>Choose a Room</Text>
              {ROOMS.map(r => {
                const active = room?.id === r.id
                const RoomIcon = r.icon
                const iconColor = active ? COLORS.white : COLORS.primary
                return (
                  <TouchableOpacity key={r.id} onPress={() => setRoom(r)} style={[s.roomCard, { backgroundColor: theme.card }, active && s.roomCardActive]} activeOpacity={0.8}>
                    {/* Top row: icon + name + check */}
                    <View style={s.roomCardTop}>
                      <View style={[s.roomIconWrap, active && s.roomIconWrapActive]}>
                        <RoomIcon size={18} color={iconColor} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.roomName, { color: theme.text }, active && s.roomNameActive]}>{r.name}</Text>
                        <View style={s.roomMeta}>
                          <Users size={11} color={active ? 'rgba(255,255,255,0.6)' : COLORS.gray400} />
                          <Text style={[s.roomCapacity, active && { color: 'rgba(255,255,255,0.7)' }]}>{r.capacity}</Text>
                          <View style={[s.roomTypeBadge, active && s.roomTypeBadgeActive]}>
                            <Text style={[s.roomTypeText, active && { color: COLORS.primary }]}>{r.type}</Text>
                          </View>
                        </View>
                      </View>
                      {active && <View style={s.checkCircle}><Check size={14} color={COLORS.white} /></View>}
                    </View>
                    {/* Description */}
                    <Text style={[s.roomDesc, { color: theme.textSub }, active && s.roomDescActive]}>{r.desc}</Text>
                    {/* Feature tags */}
                    <View style={s.featureRow}>
                      {r.features.map(f => (
                        <View key={f} style={[s.featureTag, active && s.featureTagActive]}>
                          <Text style={[s.featureText, active && s.featureTextActive]}>{f}</Text>
                        </View>
                      ))}
                    </View>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}

          {/* Step 1 — Date (horizontal scroll chips) */}
          {step === 1 && (
            <View>
              <Text style={[s.stepHeading, { color: theme.text }]}>Pick a Date</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.dateScrollRow}>
                {dates.map(d => {
                  const active = date === d.iso
                  return (
                    <TouchableOpacity key={d.iso} onPress={() => setDate(d.iso)} style={[s.dateChip, { backgroundColor: theme.card }, active && s.dateChipActive]} activeOpacity={0.8}>
                      <Text style={[s.dateWeekday, active && s.dateWeekdayActive]}>{d.weekday}</Text>
                      <Text style={[s.dateDay, { color: theme.text }, active && s.dateDayActive]}>{d.day}</Text>
                      <Text style={[s.dateMonth, active && s.dateMonthActive]}>{d.month}</Text>
                      {d.isToday && <View style={s.todayDot} />}
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>
              {date && (
                <View style={s.selectedDateBanner}>
                  <Calendar size={14} color={COLORS.primary} />
                  <Text style={s.selectedDateText}>
                    {new Date(date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Step 2 — Time (2-column grid) */}
          {step === 2 && (
            <View>
              <Text style={[s.stepHeading, { color: theme.text }]}>Pick a Time Slot</Text>
              <View style={s.timeGrid}>
                {TIME_SLOTS.map(t => {
                  const active = time === t
                  const taken = takenSlots.includes(t)
                  const past = !isSlotBookable(t, date)
                  const disabled = taken || past
                  const [start, end] = t.split(' – ')
                  return (
                    <TouchableOpacity
                      key={t}
                      onPress={() => !disabled && setTime(t)}
                      style={[s.timeCard, { backgroundColor: theme.card }, active && s.timeCardActive, disabled && s.timeCardTaken]}
                      activeOpacity={disabled ? 1 : 0.8}
                      disabled={disabled}
                    >
                      <Clock size={14} color={disabled ? COLORS.gray300 : active ? COLORS.white : COLORS.primary} style={{ marginBottom: 6 }} />
                      <Text style={[s.timeStart, { color: theme.text }, active && s.timeStartActive, disabled && s.timeStartTaken]}>{start}</Text>
                      <Text style={[s.timeEnd, active && s.timeEndActive, disabled && s.timeEndTaken]}>to {end}</Text>
                      {active && <View style={s.timeCheck}><Check size={10} color={COLORS.primary} /></View>}
                      {taken && !past && (
                        <View style={s.takenBadge}>
                          <Text style={s.takenBadgeText}>Booked</Text>
                        </View>
                      )}
                      {past && !taken && (
                        <View style={[s.takenBadge, { backgroundColor: '#9CA3AF' }]}>
                          <Text style={s.takenBadgeText}>Past</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
          )}

          {/* Step 3 — Details */}
          {step === 3 && (
            <View>
              <Text style={[s.stepHeading, { color: theme.text }]}>Booking Details</Text>
              <Text style={[s.inputLabel, { color: theme.textSub }]}>Purpose <Text style={{ color: COLORS.red }}>*</Text></Text>
              <TextInput
                style={[s.textArea, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                multiline numberOfLines={3}
                placeholder="e.g. Group study session for finals"
                placeholderTextColor={COLORS.gray400}
                value={purpose}
                onChangeText={setPurpose}
                textAlignVertical="top"
              />
              <Text style={[s.inputLabel, { color: theme.textSub }]}>Group Size <Text style={s.inputHint}>(1 – 8 people)</Text></Text>
              <View style={s.groupSizeRow}>
                {['1', '2', '3', '4', '5', '6', '7', '8'].map(n => (
                  <TouchableOpacity key={n} onPress={() => setGroupSize(n)} style={[s.groupBtn, { backgroundColor: theme.card, borderColor: theme.chipBorder }, groupSize === n && s.groupBtnActive]}>
                    <Text style={[s.groupBtnText, { color: theme.text }, groupSize === n && s.groupBtnTextActive]}>{n}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Step 4 — Confirm */}
          {step === 4 && (
            <View>
              <Text style={[s.stepHeading, { color: theme.text }]}>Confirm Your Booking</Text>
              <View style={[s.summaryCard, { backgroundColor: theme.card }]}>
                {[
                  ['Room', room?.name],
                  ['Date', new Date(date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })],
                  ['Time', time],
                  ['Group Size', `${groupSize} person(s)`],
                  ['Purpose', purpose],
                ].map(([label, value], i, arr) => (
                  <View key={label} style={[s.summaryRow, { borderBottomColor: theme.cardBorder }, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                    <Text style={[s.summaryLabel, { color: theme.textMuted }]}>{label}</Text>
                    <Text style={[s.summaryValue, { color: theme.text }]} numberOfLines={2}>{value}</Text>
                  </View>
                ))}
              </View>
              <View style={s.pendingNote}>
                <Text style={s.pendingNoteText}>Your booking will be reviewed by admin before confirmation.</Text>
              </View>
            </View>
          )}

        </ScrollView>

        {/* Bottom navigation */}
        <View style={[s.bottomBar, { backgroundColor: theme.card, borderTopColor: theme.cardBorder }]}>
          {step > 0 ? (
            <TouchableOpacity onPress={() => setStep(s => s - 1)} style={s.backBtn}>
              <Text style={s.backBtnText}>Back</Text>
            </TouchableOpacity>
          ) : <View />}

          {step < 4 ? (
            <TouchableOpacity
              onPress={() => setStep(s => s + 1)}
              disabled={!canNext}
              style={[s.nextBtn, !canNext && s.nextBtnDisabled]}
              activeOpacity={0.85}
            >
              <Text style={s.nextBtnText}>Next</Text>
              <ChevronRight size={16} color={COLORS.primary} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={handleSubmit} style={s.submitBtn} disabled={submitting} activeOpacity={0.85}>
              {submitting
                ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.nextBtnText, { marginLeft: 8 }]}>Submitting…</Text></>
                : <Text style={s.nextBtnText}>Submit Booking</Text>
              }
            </TouchableOpacity>
          )}
        </View>
        <AlertHost />
      </SafeAreaView>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.primary },
  scroll: { flex: 1, backgroundColor: '#F0F2F8' },
  body: { padding: 16, paddingBottom: 32 },

  stepHeader: { backgroundColor: COLORS.primary, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  headerLabel: { fontSize: 10, ...FONTS.bold, color: 'rgba(245,201,0,0.7)', letterSpacing: 1.5, marginBottom: 2 },
  headerTitle: { fontSize: 22, ...FONTS.extrabold, color: COLORS.white },

  stepBarWrap: { backgroundColor: COLORS.white, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.gray100 },
  stepRow: { flexDirection: 'row', alignItems: 'center' },
  stepConnector: { flex: 1, height: 2, backgroundColor: COLORS.gray200 },
  stepConnectorDone: { backgroundColor: COLORS.emerald },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.gray100, justifyContent: 'center', alignItems: 'center' },
  stepDotActive: { backgroundColor: COLORS.accent },
  stepDotDone: { backgroundColor: COLORS.emerald },
  stepNum: { fontSize: 11, ...FONTS.bold, color: COLORS.gray400, textAlign: 'center', includeFontPadding: false },
  stepNumActive: { color: COLORS.primary },

  stepHeading: { fontSize: 17, ...FONTS.extrabold, color: COLORS.gray900, marginBottom: 18 },

  // Room cards
  roomCard: { backgroundColor: COLORS.white, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 2, borderColor: 'transparent', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, elevation: 2 },
  roomCardActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary },
  roomCardTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  roomIconWrap: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#EEF0FA', justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  roomIconWrapActive: { backgroundColor: 'rgba(255,255,255,0.15)' },
  roomName: { fontSize: 13, ...FONTS.bold, color: COLORS.gray900, marginBottom: 3 },
  roomNameActive: { color: COLORS.white },
  roomMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  roomCapacity: { fontSize: 11, color: COLORS.gray400 },
  roomTypeBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: '#EEF0FA' },
  roomTypeBadgeActive: { backgroundColor: 'rgba(255,255,255,0.2)' },
  roomTypeText: { fontSize: 10, ...FONTS.bold, color: COLORS.primary },
  checkCircle: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  roomDesc: { fontSize: 11, color: COLORS.gray500, lineHeight: 15, marginBottom: 8 },
  roomDescActive: { color: 'rgba(255,255,255,0.65)' },
  featureRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  featureTag: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: '#EEF0FA' },
  featureTagActive: { backgroundColor: 'rgba(255,255,255,0.15)' },
  featureText: { fontSize: 10, ...FONTS.semibold, color: COLORS.primary },
  featureTextActive: { color: 'rgba(255,255,255,0.8)' },

  // Date chips
  dateScrollRow: { paddingHorizontal: 2, gap: 8, paddingBottom: 4 },
  dateChip: { width: 64, alignItems: 'center', paddingVertical: 14, borderRadius: 16, backgroundColor: COLORS.white, borderWidth: 2, borderColor: 'transparent', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, elevation: 1, position: 'relative' },
  dateChipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  dateWeekday: { fontSize: 10, ...FONTS.bold, color: COLORS.gray400, textTransform: 'uppercase', letterSpacing: 0.5 },
  dateWeekdayActive: { color: 'rgba(255,255,255,0.6)' },
  dateDay: { fontSize: 22, ...FONTS.extrabold, color: COLORS.gray900, marginVertical: 2 },
  dateDayActive: { color: COLORS.white },
  dateMonth: { fontSize: 10, ...FONTS.medium, color: COLORS.gray400 },
  dateMonthActive: { color: 'rgba(255,255,255,0.6)' },
  todayDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: COLORS.accent, marginTop: 4 },
  selectedDateBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#EEF0FA', borderRadius: 12, padding: 12, marginTop: 16 },
  selectedDateText: { fontSize: 13, ...FONTS.semibold, color: COLORS.primary },

  // Time grid
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  timeCard: { width: '47.5%', backgroundColor: COLORS.white, borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 2, borderColor: 'transparent', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, elevation: 1, position: 'relative' },
  timeCardActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary },
  timeStart: { fontSize: 13, ...FONTS.bold, color: COLORS.gray900, textAlign: 'center' },
  timeStartActive: { color: COLORS.white },
  timeEnd: { fontSize: 11, color: COLORS.gray400, marginTop: 2, textAlign: 'center' },
  timeEndActive: { color: 'rgba(255,255,255,0.6)' },
  timeCheck: { position: 'absolute', top: 8, right: 8, width: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.accent, justifyContent: 'center', alignItems: 'center' },
  timeCardTaken: { opacity: 0.5, borderColor: COLORS.gray200 },
  timeStartTaken: { color: COLORS.gray400 },
  timeEndTaken: { color: COLORS.gray300 },
  takenBadge: { marginTop: 6, backgroundColor: COLORS.gray200, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  takenBadgeText: { fontSize: 9, ...FONTS.bold, color: COLORS.gray500, textTransform: 'uppercase', letterSpacing: 0.5 },

  // Details
  inputLabel: { fontSize: 13, ...FONTS.semibold, color: COLORS.gray700, marginBottom: 8 },
  inputHint: { fontSize: 12, ...FONTS.regular, color: COLORS.gray400 },
  textArea: { backgroundColor: COLORS.white, borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: COLORS.gray900, marginBottom: 20, minHeight: 100 },
  groupSizeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  groupBtn: { width: 48, height: 48, borderRadius: 14, backgroundColor: COLORS.white, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: COLORS.gray200 },
  groupBtnActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary },
  groupBtnText: { fontSize: 16, ...FONTS.bold, color: COLORS.gray700 },
  groupBtnTextActive: { color: COLORS.white },

  // Summary
  summaryCard: { backgroundColor: COLORS.white, borderRadius: 18, padding: 18, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.gray100 },
  summaryLabel: { fontSize: 12, color: COLORS.gray400, ...FONTS.medium, width: 80 },
  summaryValue: { fontSize: 13, ...FONTS.semibold, color: COLORS.gray900, flex: 1, textAlign: 'right' },
  pendingNote: { backgroundColor: '#FEF3C7', borderRadius: 12, padding: 12, marginTop: 14 },
  pendingNoteText: { fontSize: 12, color: '#92400E', ...FONTS.medium, textAlign: 'center', lineHeight: 18 },

  // Bottom nav
  bottomBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, paddingBottom: 88, paddingHorizontal: 20, backgroundColor: COLORS.white },
  backBtn: { paddingHorizontal: 20, paddingVertical: 13, borderRadius: 14, backgroundColor: COLORS.gray100 },
  backBtnText: { fontSize: 14, ...FONTS.semibold, color: COLORS.gray700 },
  nextBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.accent, paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14 },
  nextBtnDisabled: { opacity: 0.35 },
  nextBtnText: { fontSize: 14, ...FONTS.bold, color: COLORS.primary },
  submitBtn: { flex: 1, backgroundColor: COLORS.accent, paddingVertical: 14, borderRadius: 14, alignItems: 'center', marginLeft: 12 },

  // Success / Ticket
  successWrap: { flexGrow: 1, alignItems: 'center', padding: 24, paddingTop: 48, paddingBottom: 120 },
  successTop: { alignItems: 'center', marginBottom: 28 },
  successCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.emerald, justifyContent: 'center', alignItems: 'center', marginBottom: 16, shadowColor: COLORS.emerald, shadowOpacity: 0.35, shadowRadius: 14, elevation: 6 },
  successTitle: { fontSize: 22, ...FONTS.extrabold, color: COLORS.gray900, marginBottom: 6 },
  successSub: { fontSize: 13, color: COLORS.gray400, textAlign: 'center' },

  ticket: { width: '100%', backgroundColor: COLORS.white, borderRadius: 20, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, marginBottom: 20, overflow: 'hidden' },
  ticketHeader: { backgroundColor: COLORS.primary, paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  ticketHeaderLabel: { fontSize: 11, ...FONTS.bold, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 },
  ticketSchool: { fontSize: 12, ...FONTS.semibold, color: 'rgba(255,255,255,0.85)' },
  pendingPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, marginTop: 2 },
  pendingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.accent },
  pendingPillText: { fontSize: 11, ...FONTS.bold, color: COLORS.accent },

  ticketIdSection: { paddingHorizontal: 18, paddingVertical: 18, alignItems: 'center' },
  ticketIdLabel: { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 10 },
  ticketIdBox: { backgroundColor: '#EEF0FA', borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
  ticketId: { fontSize: 26, ...FONTS.extrabold, color: COLORS.primary, letterSpacing: 5, fontFamily: 'monospace' },

  perfRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: -1 },
  perfHole: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#F0F2F8' },
  perfLine: { flex: 1, borderTopWidth: 1.5, borderColor: COLORS.gray200, borderStyle: 'dashed' },

  ticketDetails: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  ticketDetailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.gray100 },
  ticketDetailLabel: { fontSize: 12, color: COLORS.gray400, ...FONTS.medium },
  ticketDetailValue: { fontSize: 13, ...FONTS.semibold, color: COLORS.gray900, flex: 1, textAlign: 'right' },
  ticketFooter: { backgroundColor: '#F8F9FF', paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: COLORS.gray100 },
  ticketFooterText: { fontSize: 11, color: COLORS.gray400, textAlign: 'center', ...FONTS.medium, fontStyle: 'italic' },

  downloadBtn: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 14, marginBottom: 10 },
  downloadBtnText: { fontSize: 14, ...FONTS.bold, color: COLORS.primary },

  doneBtn: { width: '100%', backgroundColor: COLORS.primary, borderRadius: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  doneBtnText: { fontSize: 14, ...FONTS.bold, color: COLORS.white },

  // Receipt lightbox
  previewHintBtn: { alignSelf: 'center', marginTop: -12, marginBottom: 16, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#EEF0FA', borderRadius: 20 },
  previewHintText: { fontSize: 12, ...FONTS.semibold, color: COLORS.primary },
  previewOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  previewContent: { width: '100%', maxWidth: 360 },
  previewDismissHint: { textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 14 },
})
