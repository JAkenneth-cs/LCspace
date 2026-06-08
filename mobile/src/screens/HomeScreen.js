import { useEffect, useRef, useState } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput,
  Image, RefreshControl, StatusBar, Modal, Dimensions, ActivityIndicator,
  KeyboardAvoidingView, Platform
} from 'react-native'
import { collection, query, where, onSnapshot, doc, deleteDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { COLORS, FONTS } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import { useNavigation } from '@react-navigation/native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Megaphone, Calendar, MapPin, Clock, Wifi, BookOpen, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Bell, ArrowLeft, Check, Trash2, Building2, DoorClosed, MessageSquare, Send, X, Mail } from 'lucide-react-native'
import { sanitizeText } from '../lib/validation'
import { checkRateLimit, resetRateLimit, formatRetryAfter } from '../lib/rateLimit'
import { useAlert } from '../components/AlertModal'
import Svg, { Rect, Line, Circle, Defs, RadialGradient, Stop } from 'react-native-svg'

// Single door — for Collaborative Rooms (small)
function SingleDoorIcon({ size = 20, color = COLORS.primary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="4" y="2" width="16" height="20" rx="1.5" stroke={color} strokeWidth="2" />
      <Circle cx="14.5" cy="12" r="1.2" fill={color} />
    </Svg>
  )
}

// Double door — for Makers' Space (larger), two panels sharing a center line.
function DoubleDoorIcon({ size = 20, color = COLORS.primary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="2" y="2" width="20" height="20" rx="1.5" stroke={color} strokeWidth="2" />
      <Line x1="12" y1="2" x2="12" y2="22" stroke={color} strokeWidth="2" />
      <Circle cx="9.5" cy="12" r="1.2" fill={color} />
      <Circle cx="14.5" cy="12" r="1.2" fill={color} />
    </Svg>
  )
}

const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const STATUS_META = (isDark) => ({
  Pending: { bg: isDark ? 'rgba(245,158,11,0.15)' : '#FEF3C7', text: isDark ? '#FBBF24' : '#92400E', stripe: '#F59E0B' },
  Confirmed: { bg: isDark ? 'rgba(16,185,129,0.15)' : '#D1FAE5', text: isDark ? '#34D399' : '#065F46', stripe: '#10B981' },
  'Checked-In': { bg: isDark ? 'rgba(59,130,246,0.15)' : '#DBEAFE', text: isDark ? '#60A5FA' : '#1E40AF', stripe: '#3B82F6' },
  Cancelled: { bg: isDark ? 'rgba(239,68,68,0.15)' : '#FEE2E2', text: isDark ? '#F87171' : '#991B1B', stripe: '#EF4444' },
})

// Facilities overview — mirrors the website's "Available Facilities" section.
const FACILITY_ROOMS = [
  { id: 'collab-001', name: 'Collaborative Room 1', capacity: '4 – 6 people', icon: SingleDoorIcon, type: 'collaborative' },
  { id: 'collab-002', name: 'Collaborative Room 2', capacity: '4 – 6 people', icon: SingleDoorIcon, type: 'collaborative' },
  { id: 'makers-001', name: "Innovative Makers' Space 1", capacity: '6 – 8 people', icon: DoubleDoorIcon, type: 'makers' },
  { id: 'makers-002', name: "Innovative Makers' Space 2", capacity: '6 – 8 people', icon: DoubleDoorIcon, type: 'makers' },
]
const FAC_CATEGORIES = [
  { key: 'all', label: 'All Rooms', icon: Building2 },
  { key: 'collaborative', label: 'Collaborative', icon: SingleDoorIcon },
  { key: 'makers', label: "Makers' Space", icon: DoubleDoorIcon },
]
const FACILITY_SLOTS = [
  { full: '8:00 AM – 10:00 AM', label: '8AM – 10AM', start: [8, 0], end: [10, 0] },
  { full: '10:00 AM – 12:00 PM', label: '10AM – 12PM', start: [10, 0], end: [12, 0] },
  { full: '12:00 PM – 2:00 PM', label: '12PM – 2PM', start: [12, 0], end: [14, 0] },
  { full: '2:00 PM – 4:00 PM', label: '2PM – 4PM', start: [14, 0], end: [16, 0] },
]
const SLOT_STATUS_META = (isDark) => ({
  Available: { bg: isDark ? 'rgba(34,197,94,0.15)' : '#DCFCE7', text: isDark ? '#4ADE80' : '#15803D' },
  Booked: { bg: isDark ? 'rgba(239,68,68,0.15)' : '#FEE2E2', text: isDark ? '#F87171' : '#B91C1C' },
  Past: { bg: isDark ? 'rgba(255,255,255,0.08)' : '#F3F4F6', text: isDark ? '#94A3B8' : '#9CA3AF' },
})
// One facility card per slide. Each "page" spans the content width so paging snaps
// cleanly; the card itself is narrower and centered within the page so it doesn't
// stretch edge-to-edge.
const FAC_PAGE_W = Dimensions.get('window').width - 32
// Compact card centered in each page, leaving ~50px on each side for the nav arrows.
const FAC_CARD_W = Math.min(FAC_PAGE_W - 100, 280)

function FrostedCard({ children, style }) {
  return <View style={style}>{children}</View>
}

export default function HomeScreen({ profile }) {
  const { theme } = useTheme()
  const isDark = theme.type === 'dark'
  const navigation = useNavigation()
  const [bookings, setBookings] = useState([])
  const [facilitySlots, setFacilitySlots] = useState({}) // { room_id: Set(taken slot strings) }
  const [facPage, setFacPage] = useState(0)
  const [facCategory, setFacCategory] = useState('all')
  const [showLCInfo, setShowLCInfo] = useState(false)
  const { showAlert, AlertHost } = useAlert()

  // Contact Administration popup
  const [contactOpen, setContactOpen] = useState(false)
  const [cSubject, setCSubject] = useState('')
  const [cBody, setCBody] = useState('')
  const [cSending, setCSending] = useState(false)

  async function handleContactSend() {
    const cleanSubject = sanitizeText(cSubject)
    const cleanBody = sanitizeText(cBody)
    if (!cleanSubject || !cleanBody) { showAlert('Missing', 'Fill in both subject and message.'); return }
    if (cleanSubject.length < 2 || cleanBody.length < 2) { showAlert('Too Short', 'Subject and message are too short.'); return }
    const rl = await checkRateLimit('message')
    if (!rl.allowed) {
      showAlert('Too Many Messages', `Please wait ${formatRetryAfter(rl.retryAfterMs)} before sending another.`)
      return
    }
    setCSending(true)
    try {
      await addDoc(collection(db, 'admin_messages'), {
        subject: cleanSubject,
        message: cleanBody,
        direction: 'from_student',
        sender_uid: auth.currentUser.uid,
        sender_name: profile?.name || 'Student',
        sender_student_id: profile?.student_id || '',
        recipient_id: 'admin',
        recipient_uid: 'admin',
        type: 'student_message',
        created_at: serverTimestamp(),
      })
      setCSubject(''); setCBody(''); setContactOpen(false)
      resetRateLimit('message')
      showAlert('Sent', 'Your message was sent to administration.')
    } catch { showAlert('Error', 'Failed to send message. Please try again.') }
    setCSending(false)
  }

  const facScrollRef = useRef(null)

  const filteredRooms = facCategory === 'all'
    ? FACILITY_ROOMS
    : FACILITY_ROOMS.filter(r => r.type === facCategory)

  function goToFacPage(i) {
    const clamped = Math.max(0, Math.min(filteredRooms.length - 1, i))
    facScrollRef.current?.scrollTo({ x: clamped * FAC_PAGE_W, animated: true })
    setFacPage(clamped)
  }

  function selectCategory(key) {
    setFacCategory(key)
    setFacPage(0)
    setTimeout(() => facScrollRef.current?.scrollTo({ x: 0, animated: false }), 0)
  }
  const [announcements, setAnnouncements] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const [expandedAnno, setExpandedAnno] = useState(null)
  const [announcementIdx, setAnnouncementIdx] = useState(0)
  const [showNotifs, setShowNotifs] = useState(false)
  const [readIds, setReadIds] = useState([])
  const [expandedNotif, setExpandedNotif] = useState(null)
  const [dismissedIds, setDismissedIds] = useState([])

  const today = localISO(new Date())
  const firstName = (profile?.preferred_name || profile?.name || 'Student').split(' ')[0]
  const avatar = profile?.photo_url ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.name || 'S')}&background=152243&color=F5C900&size=64&rounded=true`

  const todayBooking = bookings.find(b =>
    b.booking_date === today && ['Pending', 'Confirmed', 'Checked-In', 'Active'].includes(b.status)
  )
  // Upcoming = future Pending reservations only (still awaiting admin approval)
  const upcoming = bookings.filter(b => {
    if (!b.booking_date || b.booking_date === today) return false
    if (b.status !== 'Pending') return false
    return new Date(b.booking_date + 'T00:00') > new Date()
  }).slice(0, 3)

  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    const unsub1 = onSnapshot(
      query(collection(db, 'bookings'), where('user_id', '==', uid)),
      snap => setBookings(
        snap.docs
          .map(d => ({ ...d.data(), docId: d.id }))
          .filter(b => !b.hidden_for_student)
          .sort((a, b) => (b.booking_date || '').localeCompare(a.booking_date || ''))
      )
    )
    const unsub2 = onSnapshot(
      query(collection(db, 'announcements')),
      snap => setAnnouncements(
        snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0))
          .slice(0, 5)
      )
    )
    return () => { unsub1(); unsub2() }
  }, [])

  // Auto-rotate announcements every 5s (matches web). Pauses while one is expanded.
  useEffect(() => {
    if (announcements.length <= 1 || expandedAnno) return
    const t = setInterval(() => {
      setAnnouncementIdx(prev => (prev + 1) % announcements.length)
    }, 5000)
    return () => clearInterval(t)
  }, [announcements, expandedAnno])

  // All of today's bookings (any student) → compute per-room slot availability.
  useEffect(() => {
    const ACTIVE = ['Pending', 'Confirmed', 'Checked-In', 'Active']
    const unsub = onSnapshot(
      query(collection(db, 'bookings'), where('booking_date', '==', today)),
      snap => {
        const map = {}
        snap.docs.forEach(d => {
          const b = d.data()
          if (!ACTIVE.includes(b.status)) return
          if (!map[b.room_id]) map[b.room_id] = new Set()
          map[b.room_id].add(b.time)
        })
        setFacilitySlots(map)
      },
      () => { }
    )
    return unsub
  }, [today])

  function slotStatus(roomId, slot) {
    // Match web: a slot is "Past" only once its END time has passed.
    const slotEnd = new Date(today + 'T00:00')
    slotEnd.setHours(slot.end[0], slot.end[1], 0, 0)
    if (Date.now() >= slotEnd.getTime()) return 'Past'
    if (facilitySlots[roomId]?.has(slot.full)) return 'Booked'
    return 'Available'
  }

  // Build notification list from announcements + admin messages
  const [adminMessages, setAdminMessages] = useState([])

  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    return onSnapshot(
      query(collection(db, 'admin_messages'), where('recipient_uid', '==', uid)),
      snap => setAdminMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
  }, [])

  const notifications = [
    ...announcements.map(a => ({ id: `ann_${a.id}`, title: a.title, body: a.content, type: 'announcement', ts: a.created_at?.seconds || 0 })),
    ...adminMessages.map(m => ({ id: `msg_${m.id}`, title: m.subject, body: m.message, type: 'message', ts: m.created_at?.seconds || 0 })),
  ].filter(n => !dismissedIds.includes(n.id)).sort((a, b) => b.ts - a.ts)

  const unreadCount = notifications.filter(n => !readIds.includes(n.id)).length

  function markRead(id) { setReadIds(prev => prev.includes(id) ? prev : [...prev, id]) }
  function markAllRead() { setReadIds(notifications.map(n => n.id)) }

  async function deleteNotif(n) {
    if (n.type === 'message') {
      try { await deleteDoc(doc(db, 'admin_messages', n.id.replace('msg_', ''))) } catch { }
    } else {
      setDismissedIds(prev => [...prev, n.id])
    }
    if (expandedNotif === n.id) setExpandedNotif(null)
  }

  const fmtTs = ts => ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const hour = new Date().getHours()
  const timeGreet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const unreadMail = adminMessages.filter(m => !m.read && !m.hidden_for_student).length

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <SafeAreaView style={[s.safe, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]} edges={['top']}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.type === 'dark' ? theme.bg : COLORS.primary}
        />
        <ScrollView
          style={[s.scroll, { backgroundColor: theme.bg }]}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={COLORS.accent} />}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Header ── */}
          <View style={[s.header, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]}>
            <View style={s.headerRow}>
              <View style={s.headerLeft}>
                <Text style={s.greeting}>{timeGreet}, {firstName}</Text>
                <Text style={s.dateStr}>{dateStr}</Text>
              </View>
              <View style={s.headerActions}>
                {/* LC Info icon — long press to peek */}
                <TouchableOpacity
                  onLongPress={() => setShowLCInfo(true)}
                  onPressOut={() => setShowLCInfo(false)}
                  delayLongPress={200}
                  style={s.bellBtn}
                  activeOpacity={0.8}
                >
                  <BookOpen size={18} color={COLORS.white} />
                </TouchableOpacity>

                {/* Bell icon */}
                <TouchableOpacity onPress={() => setShowNotifs(true)} style={s.bellBtn} activeOpacity={0.8}>
                  <Bell size={18} color={COLORS.white} />
                  {unreadCount > 0 && (
                    <View style={s.bellBadge}>
                      <Text style={s.bellBadgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                {/* Avatar */}
                <View style={s.avatarWrap}>
                  <Image source={{ uri: avatar }} style={s.avatar} />
                  <View style={s.avatarRing} />
                </View>
              </View>
            </View>

            {/* LC Info tooltip — shows while long pressing */}
            {showLCInfo && (
              <View style={s.lcTooltip}>
                <Text style={s.lcTooltipTitle}>Learning Commons Space</Text>
                <Text style={s.lcTooltipDesc}>USPF's collaborative learning hub for group study and digital collaboration.</Text>
                <View style={s.lcTooltipRow}><MapPin size={10} color="rgba(255,255,255,0.6)" /><Text style={s.lcTooltipMeta}>USPF Main Campus, LC Building</Text></View>
                <View style={s.lcTooltipRow}><Clock size={10} color="rgba(255,255,255,0.6)" /><Text style={s.lcTooltipMeta}>Mon – Fri · 8:00 AM – 4:00 PM</Text></View>
                <View style={s.lcTooltipRow}><Wifi size={10} color="rgba(255,255,255,0.6)" /><Text style={s.lcTooltipMeta}>High-speed WiFi included</Text></View>
              </View>
            )}

          </View>

          <View style={s.body}>

            {/* ── Announcement (auto-rotating carousel, like web) ── */}
            <View style={s.section}>
              <Text style={[s.sectionLabel, { color: theme.label }]}>Announcement</Text>
              {(() => {
                const a = announcements.length > 0
                  ? (announcements[announcementIdx] || announcements[0])
                  : null
                const isExpanded = a && expandedAnno === a.id
                return (
                  <TouchableOpacity
                    activeOpacity={a ? 0.85 : 1}
                    onPress={() => a && setExpandedAnno(isExpanded ? null : a.id)}
                  >
                    <FrostedCard style={[s.annoCard, { backgroundColor: COLORS.primary, borderColor: theme.cardBorder }]}>
                      <View style={s.annoIconWrap}>
                        <Megaphone size={18} color={COLORS.accent} />
                      </View>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={s.annoTitle} numberOfLines={isExpanded ? undefined : 1}>{a?.title || 'No new announcements'}</Text>
                        <Text style={s.annoBody} numberOfLines={isExpanded ? undefined : 2}>
                          {a?.content || 'You are all caught up!'}
                        </Text>
                        {a && (
                          <Text style={s.annoReadMore}>{isExpanded ? 'Show less ↑' : 'Read more ↓'}</Text>
                        )}
                      </View>
                    </FrostedCard>
                  </TouchableOpacity>
                )
              })()}

              {/* Pagination dots */}
              {announcements.length > 1 && (
                <View style={s.annoDots}>
                  {announcements.map((_, i) => (
                    <View key={i} style={[s.annoDot, i === announcementIdx && s.annoDotActive]} />
                  ))}
                </View>
              )}
            </View>

            {/* ── Available Facilities ── */}
            <View style={s.section}>
              <View style={s.facHeaderRow}>
                <Text style={[s.sectionLabel, { color: theme.label, marginBottom: 0 }]}>Available Facilities</Text>
                <TouchableOpacity onPress={() => navigation.navigate('Reserve')} style={s.facReserveLink} activeOpacity={0.7}>
                  <Text style={s.facReserveLinkText}>Reserve</Text>
                  <ChevronRight size={13} color={COLORS.primary} />
                </TouchableOpacity>
              </View>
              {/* Category selector */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.facCatRow} style={{ marginBottom: 14 }}>
                {FAC_CATEGORIES.map(({ key, label, icon: CatIcon }) => {
                  const active = facCategory === key
                  const iconColor = active ? COLORS.white : COLORS.primary
                  return (
                    <TouchableOpacity key={key} onPress={() => selectCategory(key)} style={s.facCatItem} activeOpacity={0.75}>
                      <View style={[s.facCatCircle, { backgroundColor: theme.metaChip }, active && s.facCatCircleActive]}>
                        <CatIcon size={22} color={iconColor} />
                      </View>
                      <Text style={[s.facCatLabel, active && s.facCatLabelActive]}>{label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>

              <View style={s.facSliderWrap}>
                <ScrollView
                  ref={facScrollRef}
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  onScroll={e => {
                    const x = e.nativeEvent.contentOffset.x
                    const p = Math.round(x / FAC_PAGE_W)
                    if (p !== facPage) setFacPage(p)
                  }}
                  scrollEventThrottle={16}
                >
                  {filteredRooms.map(r => {
                    const RoomIcon = r.icon
                    return (
                      <View key={r.id} style={s.facPage}>
                        <FrostedCard style={[s.facCard, { width: FAC_CARD_W, backgroundColor: theme.card, borderColor: theme.cardBorder, borderWidth: 1 }]}>
                          <View style={s.facTop}>
                            <View style={[s.facIconWrap, { backgroundColor: theme.metaChip }]}>
                              <RoomIcon size={18} color={COLORS.primary} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={[s.facName, { color: theme.text }]}>{r.name}</Text>
                              <Text style={s.facCapacity}>{r.capacity}</Text>
                            </View>
                          </View>
                          <Text style={s.facSlotsLabel}>TODAY'S SLOTS</Text>
                          <View style={s.facSlotList}>
                            {FACILITY_SLOTS.map(slot => {
                              const st = slotStatus(r.id, slot)
                              const meta = SLOT_STATUS_META(isDark)[st]
                              return (
                                <View key={slot.full} style={s.facSlotRow}>
                                  <Text style={[s.facSlotLabel, { color: theme.textSub }]}>{slot.label}</Text>
                                  <View style={[s.facSlotPill, { backgroundColor: meta.bg }]}>
                                    <Text style={[s.facSlotPillText, { color: meta.text }]}>{st}</Text>
                                  </View>
                                </View>
                              )
                            })}
                          </View>
                          <TouchableOpacity
                            onPress={() => navigation.navigate('Reserve', { roomId: r.id, ts: Date.now() })}
                            style={[s.facReserveBtn, { backgroundColor: theme.metaChip }]}
                            activeOpacity={0.85}
                          >
                            <Text style={s.facReserveBtnText}>Reserve</Text>
                          </TouchableOpacity>
                        </FrostedCard>
                      </View>
                    )
                  })}
                </ScrollView>

                {/* Side navigation arrows */}
                <TouchableOpacity
                  onPress={() => goToFacPage(facPage - 1)}
                  disabled={facPage === 0}
                  style={[s.facArrow, s.facArrowLeft, facPage === 0 && s.facArrowDisabled]}
                  activeOpacity={0.7}
                >
                  <ChevronLeft size={20} color={COLORS.primary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => goToFacPage(facPage + 1)}
                  disabled={facPage === filteredRooms.length - 1}
                  style={[s.facArrow, s.facArrowRight, facPage === filteredRooms.length - 1 && s.facArrowDisabled]}
                  activeOpacity={0.7}
                >
                  <ChevronRight size={20} color={COLORS.primary} />
                </TouchableOpacity>
              </View>

              {/* Page dots */}
              <View style={s.facDots}>
                {filteredRooms.map((_, i) => (
                  <View key={i} style={[s.facDot, i === facPage && s.facDotActive]} />
                ))}
              </View>
            </View>


            {/* ── Upcoming ── */}
            {upcoming.length > 0 && (
              <View style={s.section}>
                <Text style={[s.sectionLabel, { color: theme.label }]}>Upcoming · Pending</Text>
                {upcoming.map(b => {
                  const sm = STATUS_META(isDark)[b.status] || { bg: COLORS.gray100, text: COLORS.gray500, stripe: COLORS.gray300 }
                  return (
                    <View key={b.docId} style={[s.upcomingCard, { backgroundColor: theme.card }]}>
                      <View style={[s.upcomingStripe, { backgroundColor: sm.stripe }]} />
                      <View style={s.upcomingContent}>
                        <View style={{ flex: 1 }}>
                          <Text style={[s.upcomingRoom, { color: theme.text }]}>{b.room_name}</Text>
                          <Text style={s.upcomingDate}>{b.booking_date} · {b.time}</Text>
                        </View>
                        <View style={[s.statusBadge, { backgroundColor: sm.bg }]}>
                          <Text style={[s.statusText, { color: sm.text }]}>{b.status}</Text>
                        </View>
                      </View>
                    </View>
                  )
                })}
              </View>
            )}

          </View>
        </ScrollView>

        {/* ── Floating Contact Administration button ── */}
        <TouchableOpacity style={[s.mailFab, isDark && { shadowColor: '#000', shadowOpacity: 0.35 }]} activeOpacity={0.85} onPress={() => setContactOpen(true)}>
          <MessageSquare size={22} color={COLORS.primary} />
          {unreadMail > 0 && (
            <View style={s.mailFabBadge}>
              <Text style={s.mailFabBadgeText}>{unreadMail > 9 ? '9+' : unreadMail}</Text>
            </View>
          )}
        </TouchableOpacity>

        {/* ── Contact Administration popup ── */}
        <Modal visible={contactOpen} transparent animationType="slide" onRequestClose={() => setContactOpen(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.contactOverlay}>
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setContactOpen(false)} />
            <View style={[s.contactSheet, { backgroundColor: theme.modal }]}>

              {/* Navy header */}
              <View style={s.contactHeader}>
                <View style={s.contactHeaderIcon}>
                  <MessageSquare size={20} color={COLORS.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.contactTitle}>Contact Administration</Text>
                  <Text style={s.contactSubtitle}>Send a message — replies arrive in your Mail</Text>
                </View>
                <TouchableOpacity onPress={() => setContactOpen(false)} style={s.contactClose}>
                  <X size={18} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={s.contactBody} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <Text style={[s.contactLabel, { color: theme.textSub }]}>SUBJECT</Text>
                <TextInput
                  style={[s.contactInput, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                  value={cSubject}
                  onChangeText={setCSubject}
                  placeholder="What is this about?"
                  placeholderTextColor={COLORS.gray400}
                />
                <Text style={[s.contactLabel, { color: theme.textSub }]}>MESSAGE</Text>
                <TextInput
                  style={[s.contactTextarea, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                  value={cBody}
                  onChangeText={v => setCBody(v.slice(0, 1000))}
                  placeholder="Write your message to administration..."
                  placeholderTextColor={COLORS.gray400}
                  multiline
                  textAlignVertical="top"
                />
                <Text style={[s.contactCount, { color: theme.textMuted }]}>{cBody.length}/1000</Text>

                <View style={s.contactActions}>
                  <TouchableOpacity onPress={handleContactSend} style={[s.contactSendBtn, cSending && { opacity: 0.6 }]} disabled={cSending} activeOpacity={0.85}>
                    {cSending
                      ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.contactSendText, { marginLeft: 6 }]}>Sending…</Text></>
                      : <><Send size={15} color={COLORS.primary} /><Text style={s.contactSendText}>Send Message</Text></>
                    }
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setContactOpen(false)} style={[s.contactCancelBtn, { borderColor: theme.cardBorder }]} activeOpacity={0.85}>
                    <Text style={[s.contactCancelText, { color: theme.textSub }]}>Cancel</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity onPress={() => { setContactOpen(false); navigation.navigate('Mail') }} style={s.contactViewAll} activeOpacity={0.7}>
                  <Mail size={14} color={COLORS.primary} />
                  <Text style={s.contactViewAllText}>View all messages{adminMessages.length ? ` (${adminMessages.length})` : ''}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* ── Notification bottom sheet ── */}
        <Modal visible={showNotifs} transparent animationType="slide" onRequestClose={() => setShowNotifs(false)}>
          <View style={s.sheetOverlay}>
            {/* Tap the empty space above the sheet to close */}
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowNotifs(false)} />
            <View style={[s.notifSheet, { backgroundColor: theme.modal }]}>
              <View style={s.notifHandleArea}>
                <View style={[s.sheetHandle, { backgroundColor: theme.cardBorder }]} />
              </View>

              {/* Header */}
              <View style={[s.notifSheetHeader, { borderBottomColor: theme.cardBorder }]}>
                <View>
                  <Text style={[s.notifTitle, { color: theme.text }]}>Notifications</Text>
                  {unreadCount > 0 && <Text style={s.notifSubtitle}>{unreadCount} unread</Text>}
                </View>
                {unreadCount > 0 && (
                  <TouchableOpacity onPress={markAllRead} style={[s.markAllBtn, { backgroundColor: theme.metaChip }]}>
                    <Text style={s.markAllText}>Mark all read</Text>
                  </TouchableOpacity>
                )}
              </View>

              <ScrollView contentContainerStyle={s.notifList} showsVerticalScrollIndicator={false}>
                {notifications.length === 0 ? (
                  <View style={s.notifEmpty}>
                    <Bell size={28} color={COLORS.gray200} />
                    <Text style={s.notifEmptyText}>No notifications yet</Text>
                  </View>
                ) : notifications.map(n => {
                  const isRead = readIds.includes(n.id)
                  const isExpanded = expandedNotif === n.id
                  return (
                    <TouchableOpacity
                      key={n.id}
                      style={[s.notifItem, { backgroundColor: theme.card }, isRead && s.notifItemRead]}
                      onPress={() => { setExpandedNotif(isExpanded ? null : n.id); markRead(n.id) }}
                      activeOpacity={0.75}
                    >
                      {!isRead && <View style={s.notifDot} />}
                      <View style={[s.notifIconWrap, { backgroundColor: n.type === 'message' ? (isDark ? 'rgba(59,130,246,0.15)' : '#DBEAFE') : theme.metaChip }]}>
                        {n.type === 'message'
                          ? <Bell size={14} color="#3B82F6" />
                          : <Megaphone size={14} color={COLORS.primary} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={s.notifItemTop}>
                          <Text style={[s.notifItemTitle, { color: theme.text }, isRead && s.notifItemTitleRead]} numberOfLines={1}>{n.title}</Text>
                          <Text style={s.notifItemDate}>{fmtTs(n.ts)}</Text>
                        </View>
                        <Text style={[s.notifItemBody, { color: theme.textMuted }, isExpanded && { color: theme.textSub }]}
                          numberOfLines={isExpanded ? undefined : 2}>{n.body}</Text>
                        {isExpanded && (
                          <View style={s.notifActions}>
                            {!isRead && (
                              <TouchableOpacity onPress={() => markRead(n.id)} style={[s.notifActionBtn, { backgroundColor: theme.metaChip }]}>
                                <Check size={13} color={COLORS.primary} />
                                <Text style={s.notifActionText}>Mark as read</Text>
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity onPress={() => deleteNotif(n)} style={[s.notifActionBtn, s.notifDeleteBtn]}>
                              <Trash2 size={13} color={COLORS.red} />
                              <Text style={[s.notifActionText, { color: COLORS.red }]}>Delete</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>

        <AlertHost />
      </SafeAreaView>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.primary },
  scroll: { flex: 1, backgroundColor: '#F0F2F8' },

  header: { backgroundColor: COLORS.primary, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 },

  // LC Info tooltip (shows on long press)
  lcTooltip: { backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 14, padding: 14, marginTop: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  lcTooltipTitle: { fontSize: 13, ...FONTS.bold, color: COLORS.white, marginBottom: 4 },
  lcTooltipDesc: { fontSize: 11, color: 'rgba(255,255,255,0.65)', lineHeight: 16, marginBottom: 8 },
  lcTooltipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  lcTooltipMeta: { fontSize: 11, color: 'rgba(255,255,255,0.6)' },


  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 0 },
  headerLeft: { flex: 1 },
  greeting: { fontSize: 18, ...FONTS.bold, color: COLORS.white },
  dateStr: { fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 3, ...FONTS.regular },
  avatarWrap: { position: 'relative', marginLeft: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  avatarRing: { position: 'absolute', top: -2, left: -2, right: -2, bottom: -2, borderRadius: 23, borderWidth: 2, borderColor: COLORS.accent },

  infoStrip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, paddingHorizontal: 4, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  stripItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  stripSep: { width: 1, height: 13, backgroundColor: 'rgba(255,255,255,0.15)' },
  stripText: { fontSize: 11, color: 'rgba(255,255,255,0.7)', ...FONTS.semibold },

  body: { padding: 16, paddingBottom: 104 },

  // Floating Mail button (matches web)
  mailFab: { position: 'absolute', right: 16, bottom: 92, width: 54, height: 54, borderRadius: 18, backgroundColor: COLORS.accent, justifyContent: 'center', alignItems: 'center', shadowColor: COLORS.accent, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  mailFabBadge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.red, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5, borderWidth: 2, borderColor: '#F0F2F8' },
  mailFabBadgeText: { fontSize: 10, ...FONTS.bold, color: COLORS.white },

  // Contact Administration popup
  contactOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  contactSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', paddingBottom: 24, maxHeight: '88%' },
  contactHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: COLORS.primary, paddingHorizontal: 16, paddingVertical: 16 },
  contactHeaderIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: COLORS.accent, justifyContent: 'center', alignItems: 'center' },
  contactTitle: { fontSize: 16, ...FONTS.extrabold, color: COLORS.white },
  contactSubtitle: { fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 },
  contactClose: { width: 30, height: 30, justifyContent: 'center', alignItems: 'center' },
  contactBody: { padding: 18 },
  contactLabel: { fontSize: 10, ...FONTS.bold, letterSpacing: 1, marginBottom: 8 },
  contactInput: { borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, marginBottom: 16 },
  contactTextarea: { borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, minHeight: 120, marginBottom: 4 },
  contactCount: { fontSize: 11, textAlign: 'right', marginBottom: 14 },
  contactActions: { flexDirection: 'row', gap: 10 },
  contactSendBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 14 },
  contactSendText: { fontSize: 14, ...FONTS.bold, color: COLORS.primary },
  contactCancelBtn: { paddingHorizontal: 22, justifyContent: 'center', alignItems: 'center', borderRadius: 14, borderWidth: 1.5 },
  contactCancelText: { fontSize: 14, ...FONTS.semibold },
  contactViewAll: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16 },
  contactViewAllText: { fontSize: 13, ...FONTS.semibold, color: COLORS.primary },
  section: { marginBottom: 20 },
  sectionLabel: { fontSize: 11, ...FONTS.bold, color: '#8B90A0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },

  // Available Facilities — horizontal slider
  facHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  facReserveLink: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  facReserveLinkText: { fontSize: 12, ...FONTS.bold, color: COLORS.primary },
  facCatRow: { flexDirection: 'row', gap: 20, paddingHorizontal: 4 },
  facCatItem: { alignItems: 'center', gap: 6 },
  facCatCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#EEF0FA', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'transparent' },
  facCatCircleActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  facCatLabel: { fontSize: 11, ...FONTS.semibold, color: COLORS.gray500, textAlign: 'center', maxWidth: 70 },
  facCatLabelActive: { color: COLORS.primary, ...FONTS.bold },

  facSliderWrap: { position: 'relative' },
  facPage: { width: FAC_PAGE_W, alignItems: 'center' },
  facCard: { borderRadius: 18, padding: 16, width: FAC_CARD_W, minHeight: 240 },
  facArrow: { position: 'absolute', top: '50%', marginTop: -14, justifyContent: 'center', alignItems: 'center', zIndex: 5 },
  facArrowLeft: { left: 0 },
  facArrowRight: { right: 0 },
  facArrowDisabled: { opacity: 0.2 },
  facDots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 12 },
  facDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.gray300 },
  facDotActive: { width: 18, backgroundColor: COLORS.primary },
  facTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  facIconWrap: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#EEF0FA', justifyContent: 'center', alignItems: 'center' },
  facName: { fontSize: 13, ...FONTS.bold, color: COLORS.gray900 },
  facCapacity: { fontSize: 11, color: COLORS.gray400, marginTop: 1 },
  facSlotsLabel: { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  facSlotList: { gap: 7, marginBottom: 12 },
  facSlotRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  facSlotLabel: { fontSize: 12, ...FONTS.medium, color: COLORS.gray600 },
  facSlotPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, minWidth: 72, alignItems: 'center' },
  facSlotPillText: { fontSize: 11, ...FONTS.bold },
  facReserveBtn: { backgroundColor: '#EEF0FA', borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  facReserveBtnText: { fontSize: 13, ...FONTS.bold, color: COLORS.primary },

  annoCard: { backgroundColor: COLORS.primary, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  annoIconWrap: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(245,201,0,0.15)', justifyContent: 'center', alignItems: 'center' },
  annoTitle: { fontSize: 14, ...FONTS.bold, color: COLORS.white },
  annoBody: { fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 18 },
  annoReadMore: { fontSize: 11, ...FONTS.semibold, color: COLORS.accent, marginTop: 2 },
  annoDots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginTop: 10 },
  annoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.gray300 },
  annoDotActive: { width: 16, backgroundColor: COLORS.primary },

  bookingCard: { backgroundColor: COLORS.white, borderRadius: 16, overflow: 'hidden', flexDirection: 'row', shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 10, elevation: 3 },
  bookingStripe: { width: 5, backgroundColor: COLORS.primary },
  bookingContent: { flex: 1, padding: 16 },
  bookingTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bookingRoom: { fontSize: 15, ...FONTS.bold, color: COLORS.gray900, marginBottom: 4 },
  bookingTime: { fontSize: 12, color: COLORS.gray400, ...FONTS.medium },
  bookingFooter: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: COLORS.gray100 },
  bookingId: { fontSize: 11, color: COLORS.gray400, fontFamily: 'monospace' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, flexShrink: 0 },
  statusText: { fontSize: 11, ...FONTS.bold },

  emptyCard: { backgroundColor: COLORS.white, borderRadius: 16, padding: 20, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  emptyIconWrap: { width: 44, height: 44, borderRadius: 12, backgroundColor: COLORS.gray100, justifyContent: 'center', alignItems: 'center' },
  emptyTitle: { fontSize: 14, ...FONTS.semibold, color: COLORS.gray700 },
  emptySubtitle: { fontSize: 12, color: COLORS.gray400, marginTop: 2 },

  upcomingCard: { backgroundColor: COLORS.white, borderRadius: 14, overflow: 'hidden', flexDirection: 'row', marginBottom: 8, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, elevation: 1 },
  upcomingStripe: { width: 4 },
  upcomingContent: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 14, gap: 8 },
  upcomingRoom: { fontSize: 13, ...FONTS.semibold, color: COLORS.gray900 },
  upcomingDate: { fontSize: 11, color: COLORS.gray400, marginTop: 2 },

  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bellBtn: { justifyContent: 'center', alignItems: 'center', position: 'relative', padding: 4 },
  bellBadge: { position: 'absolute', top: -4, right: -4, minWidth: 17, height: 17, borderRadius: 9, backgroundColor: COLORS.red, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3, borderWidth: 1.5, borderColor: COLORS.primary },
  bellBadgeText: { fontSize: 9, ...FONTS.extrabold, color: COLORS.white },

  // Bottom sheet shared
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 14, backgroundColor: COLORS.gray200 },

  // Notification sheet
  notifSheet: { backgroundColor: COLORS.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: Dimensions.get('window').height * 0.72, paddingBottom: 24 },
  notifHandleArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 6, paddingHorizontal: 60 },
  notifSheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: 1, marginBottom: 4 },
  notifTitle: { fontSize: 17, ...FONTS.extrabold, color: COLORS.gray900 },
  notifSubtitle: { fontSize: 12, color: COLORS.gray400, marginTop: 2 },
  notifHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  markAllBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#EEF0FA' },
  markAllText: { fontSize: 12, ...FONTS.semibold, color: COLORS.primary },
  notifCloseBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: COLORS.gray100, justifyContent: 'center', alignItems: 'center' },

  notifList: { padding: 16, gap: 2, paddingBottom: 40 },
  notifEmpty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  notifEmptyText: { fontSize: 14, color: COLORS.gray400, ...FONTS.medium },

  notifItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 14, backgroundColor: COLORS.white },
  notifItemRead: { opacity: 0.55 },
  notifDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: COLORS.primary, marginTop: 5, flexShrink: 0 },
  notifIconWrap: { width: 36, height: 36, borderRadius: 10, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  notifItemTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  notifItemTitle: { fontSize: 13, ...FONTS.bold, color: COLORS.gray900, flex: 1, marginRight: 8 },
  notifItemTitleRead: { ...FONTS.medium, color: COLORS.gray500 },
  notifItemDate: { fontSize: 11, color: COLORS.gray400 },
  notifItemBody: { fontSize: 12, color: COLORS.gray400, lineHeight: 17 },

  notifActions: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  notifActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.gray100 },
  notifActionText: { fontSize: 12, ...FONTS.semibold, color: COLORS.primary },
  notifDeleteBtn: { backgroundColor: '#FEE2E2' },

  notifBackBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: COLORS.gray100, justifyContent: 'center', alignItems: 'center', marginRight: 12 },


  infoCard: { backgroundColor: COLORS.white, borderRadius: 14, padding: 16, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2, borderLeftWidth: 4, borderLeftColor: COLORS.primary },
  infoDesc: { fontSize: 12, color: COLORS.gray500, lineHeight: 18, marginBottom: 12 },
  infoDivider: { height: 1, backgroundColor: COLORS.gray100, marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  infoIconCircle: { width: 24, height: 24, borderRadius: 6, backgroundColor: '#EEF0FA', justifyContent: 'center', alignItems: 'center' },
  infoRowText: { fontSize: 12, color: COLORS.gray600 || COLORS.gray500, ...FONTS.medium },
})
