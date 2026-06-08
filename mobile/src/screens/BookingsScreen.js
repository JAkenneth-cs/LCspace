import { useEffect, useRef, useState } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Image,
  Alert, ActivityIndicator, StatusBar, Modal,
} from 'react-native'
import Svg, { Defs, Path, Circle, G, Text as SvgText, TextPath, Rect } from 'react-native-svg'
import { collection, query, where, onSnapshot, doc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { COLORS, FONTS } from '../lib/theme'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ClipboardList, Clock, Users, X, Calendar, Download, ArrowLeft, FileText, Check, Trash2, Monitor } from 'lucide-react-native'
import { useNavigation } from '@react-navigation/native'
import ViewShot from 'react-native-view-shot'
import * as MediaLibrary from 'expo-media-library'
import * as Sharing from 'expo-sharing'
import { useTheme } from '../lib/ThemeContext'
import CyberspaceAccessModal from '../components/CyberspaceAccessModal'
import { useAlert } from '../components/AlertModal'

const STATUS_META = (isDark) => ({
  Pending: { bg: isDark ? 'rgba(245,158,11,0.15)' : '#FEF3C7', text: isDark ? '#FBBF24' : '#92400E', stripe: '#F59E0B' },
  Confirmed: { bg: isDark ? 'rgba(16,185,129,0.15)' : '#D1FAE5', text: isDark ? '#34D399' : '#065F46', stripe: '#10B981' },
  'Checked-In': { bg: isDark ? 'rgba(59,130,246,0.15)' : '#DBEAFE', text: isDark ? '#60A5FA' : '#1E40AF', stripe: '#3B82F6' },
  Done: { bg: isDark ? 'rgba(5,150,105,0.15)' : '#D1FAE5', text: isDark ? '#34D399' : '#047857', stripe: '#059669' },
  Cancelled: { bg: isDark ? 'rgba(239,68,68,0.15)' : '#FEE2E2', text: isDark ? '#F87171' : '#991B1B', stripe: '#EF4444' },
})

const FILTERS = ['All', 'Pending', 'Confirmed', 'Checked-In', 'Done', 'Cancelled']

export default function BookingsScreen() {
  const { theme } = useTheme()
  const isDark = theme.type === 'dark'
  const navigation = useNavigation()
  const { showAlert, AlertHost } = useAlert()
  const [bookings, setBookings] = useState([])
  const [filter, setFilter] = useState('All')
  const [cancelling, setCancelling] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [selectedBooking, setSelectedBooking] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [cyberspaceBooking, setCyberspaceBooking] = useState(null)
  const receiptRef = useRef()

  function canShowCyberspace(b) {
    return b.status !== 'Cancelled'
  }


  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    // FIX: spread data first, then set docId = Firestore document ID
    // (prevents custom 'id' field in data from overwriting the doc ID)
    return onSnapshot(
      query(collection(db, 'bookings'), where('user_id', '==', uid)),
      snap => setBookings(
        snap.docs
          .map(d => ({ ...d.data(), docId: d.id }))
          .filter(b => !b.hidden_for_student)
          .sort((a, b) => (b.booking_date || '').localeCompare(a.booking_date || ''))
      )
    )
  }, [])

  const shown = filter === 'All' ? bookings : bookings.filter(b => b.status === filter)
  const countFor = f => f === 'All' ? bookings.length : bookings.filter(b => b.status === f).length

  // Parse "8:00 AM – 10:00 AM" → Date on booking_date
  function bookingStartDate(b) {
    if (!b.booking_date || !b.time) return null
    const part = b.time.split(' – ')[0].trim()
    const [hhmm, period] = part.split(' ')
    let [h, m] = hhmm.split(':').map(Number)
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    const d = new Date(b.booking_date + 'T00:00')
    d.setHours(h, m, 0, 0)
    return d
  }

  // Cancel: only Pending, and booking start is > 15 min away
  function canCancelBooking(b) {
    if (b.status !== 'Pending') return false
    const start = bookingStartDate(b)
    if (!start) return false
    return start - new Date() > 15 * 60 * 1000
  }

  // Delete: only non-Pending (Confirmed, Checked-In, Cancelled)
  function canDeleteBooking(b) {
    return b.status !== 'Pending'
  }

  async function handleCancel(booking) {
    showAlert('Cancel Booking', `Cancel reservation for "${booking.room_name}"?`, [
      { text: 'Keep It', style: 'cancel' },
      {
        text: 'Yes, Cancel', style: 'destructive',
        onPress: async () => {
          setCancelling(booking.docId)
          try {
            await updateDoc(doc(db, 'bookings', booking.docId), {
              status: 'Cancelled',
              cancelled_at: serverTimestamp(),
            })
          } catch {
            showAlert('Error', 'Could not cancel booking. Please try again.')
          }
          setCancelling(null)
        },
      },
    ])
  }

  async function handleDelete(booking) {
    showAlert(
      'Remove from My Reservations',
      `Remove the reservation for "${booking.room_name}" from your list? The record will still be retained by the admin.`,
      [
        { text: 'Keep It', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            setDeleting(booking.docId)
            try {
              await updateDoc(doc(db, 'bookings', booking.docId), {
                hidden_for_student: true,
                hidden_for_student_at: serverTimestamp(),
              })
              if (selectedBooking?.docId === booking.docId) setSelectedBooking(null)
            } catch {
              showAlert('Error', 'Could not remove reservation. Please try again.')
            }
            setDeleting(null)
          },
        },
      ]
    )
  }

  async function handleDownload() {
    setDownloading(true)
    try {
      // Small delay so the SVG seal finishes painting before capture
      await new Promise(r => setTimeout(r, 80))
      const uri = await receiptRef.current.capture()

      // Prefer the OS share sheet — works in Expo Go and dev builds, lets the user
      // save to Photos, send via Messenger / Gmail, etc.
      const shareAvailable = await Sharing.isAvailableAsync()
      if (shareAvailable) {
        await Sharing.shareAsync(uri, {
          mimeType: 'image/png',
          dialogTitle: 'Save or share receipt',
          UTI: 'public.png',
        })
        setDownloading(false)
        return
      }

      // Fallback: save directly to the photo library (production/dev builds only)
      const { status } = await MediaLibrary.requestPermissionsAsync(true, ['photo'])
      if (status !== 'granted') {
        showAlert('Permission Required', 'Please allow photo access to save the receipt.')
        setDownloading(false)
        return
      }
      await MediaLibrary.saveToLibraryAsync(uri)
      showAlert('Saved!', 'Receipt has been saved to your photo library.')
    } catch (err) {
      console.warn('Receipt download error:', err)
      showAlert('Error', `Could not save receipt: ${err?.message || 'unknown error'}`)
    }
    setDownloading(false)
  }

  const fmtDate = iso => {
    if (!iso) return '—'
    return new Date(iso + 'T00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    })
  }

  const fmtStamp = ts => {
    if (!ts) return '—'
    const ms = ts?.seconds ? ts.seconds * 1000 : new Date(ts).getTime()
    if (!ms || isNaN(ms)) return '—'
    return new Date(ms).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  }

  const sel = selectedBooking
  const selSm = sel ? (STATUS_META(isDark)[sel.status] || { bg: COLORS.gray100, text: COLORS.gray500, stripe: COLORS.gray300 }) : {}

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <SafeAreaView style={[s.safe, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]} edges={['top']}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.type === 'dark' ? theme.bg : COLORS.primary}
        />

        {/* ── Header ── */}
        <View style={[s.header, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]}>
          <Text style={s.headerLabel}>MY RESERVATIONS</Text>
          <Text style={s.headerTitle}>Bookings</Text>
        </View>

        {/* ── Filter chips ── */}
        <View style={[s.filterWrap, { backgroundColor: theme.filterWrap }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
            {FILTERS.map(f => {
              const active = filter === f
              const cnt = countFor(f)
              return (
                <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[s.chip, { backgroundColor: theme.chipBg, borderColor: theme.chipBorder }, active && s.chipActive]}>
                  <Text style={[s.chipText, { color: theme.textSub }, active && s.chipTextActive]}>{f}</Text>
                  {cnt > 0 && (
                    <View style={[s.chipBadge, active && s.chipBadgeActive]}>
                      <Text style={[s.chipBadgeText, active && s.chipBadgeTextActive]}>{cnt}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              )
            })}
          </ScrollView>
        </View>

        {/* ── List ── */}
        <ScrollView style={[s.scroll, { backgroundColor: theme.bg }]} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
          {shown.length === 0 ? (
            <View style={s.empty}>
              <View style={[s.emptyIconWrap, { backgroundColor: theme.card }]}>
                <ClipboardList size={28} color={COLORS.gray300} />
              </View>
              <Text style={s.emptyTitle}>No {filter === 'All' ? '' : filter.toLowerCase() + ' '}bookings</Text>
              <Text style={s.emptySubtitle}>Your reservations will appear here</Text>
            </View>
          ) : shown.map(b => {
            const sm = STATUS_META(isDark)[b.status] || { bg: COLORS.gray100, text: COLORS.gray500, stripe: COLORS.gray300 }
            const canCancel = canCancelBooking(b)
            const canDelete = canDeleteBooking(b)
            const isCancelling = cancelling === b.docId
            const displayId = b.id || b.docId?.slice(0, 8).toUpperCase()
            return (
              <View key={b.docId} style={[s.card, { backgroundColor: theme.card }]}>
                <View style={[s.cardStripe, { backgroundColor: sm.stripe }]} />
                <View style={s.cardInner}>
                  {/* Top row */}
                  <View style={s.cardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.roomName, { color: theme.text }]} numberOfLines={1}>{b.room_name}</Text>
                      {b.purpose ? (
                        <Text style={[s.purposeText, { color: theme.textMuted }]} numberOfLines={1}>{b.purpose}</Text>
                      ) : null}
                    </View>
                    <View style={[s.statusBadge, { backgroundColor: sm.bg }]}>
                      <Text style={[s.statusText, { color: sm.text }]}>{b.status}</Text>
                    </View>
                  </View>

                  {/* Meta chips */}
                  <View style={s.metaRow}>
                    <View style={[s.metaChip, { backgroundColor: theme.metaChip }]}>
                      <Calendar size={10} color={COLORS.primary} />
                      <Text style={s.metaText}>{fmtDate(b.booking_date)}</Text>
                    </View>
                    <View style={[s.metaChip, { backgroundColor: theme.metaChip }]}>
                      <Clock size={10} color={COLORS.primary} />
                      <Text style={s.metaText}>{b.time}</Text>
                    </View>
                    <View style={[s.metaChip, { backgroundColor: theme.metaChip }]}>
                      <Users size={10} color={COLORS.primary} />
                      <Text style={s.metaText}>{b.group_size || 1} pax</Text>
                    </View>
                  </View>

                  {b.confirmed_at && (
                    <Text style={[s.confirmedAtText, { color: theme.textMuted }]} numberOfLines={1}>
                      Confirmed by admin · {fmtStamp(b.confirmed_at)}
                    </Text>
                  )}

                  {/* Footer */}
                  <View style={[s.cardFooter, { borderTopColor: theme.cardBorder }]}>
                    <Text style={[s.bookingId, { color: theme.textMuted }]}>#{displayId}</Text>
                    <View style={s.cardActions}>
                      {canShowCyberspace(b) && (
                        <TouchableOpacity onPress={() => setCyberspaceBooking(b)} style={s.cyberBtn}>
                          <Monitor size={12} color={COLORS.white} />
                          <Text style={s.cyberBtnText}>Cyberspace</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => setSelectedBooking(b)} style={s.receiptBtn}>
                        <FileText size={12} color={COLORS.primary} />
                        <Text style={s.receiptBtnText}>Receipt</Text>
                      </TouchableOpacity>
                      {canCancel && (
                        <TouchableOpacity
                          onPress={() => handleCancel(b)}
                          style={s.cancelBtn}
                          disabled={isCancelling}
                        >
                          {isCancelling
                            ? <><ActivityIndicator size="small" color={COLORS.red} /><Text style={[s.cancelText, { marginLeft: 4 }]}>Cancelling…</Text></>
                            : <><X size={11} color={COLORS.red} /><Text style={s.cancelText}>Cancel</Text></>
                          }
                        </TouchableOpacity>
                      )}
                      {canDelete && (
                        <TouchableOpacity
                          onPress={() => handleDelete(b)}
                          style={s.deleteBtn}
                          disabled={deleting === b.docId}
                        >
                          {deleting === b.docId
                            ? <><ActivityIndicator size="small" color={COLORS.gray400} /><Text style={[s.cancelText, { marginLeft: 4, color: COLORS.gray400 }]}>Deleting…</Text></>
                            : <Trash2 size={14} color={COLORS.gray400} />
                          }
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>
              </View>
            )
          })}
        </ScrollView>

        {/* ── Receipt Modal — lightbox overlay ── */}
        <Modal
          visible={!!sel}
          animationType="fade"
          transparent
          onRequestClose={() => setSelectedBooking(null)}
        >
          <TouchableOpacity style={s.lightboxOverlay} activeOpacity={1} onPress={() => setSelectedBooking(null)}>
            <TouchableOpacity activeOpacity={1} onPress={() => { }} style={s.lightboxContent}>
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
                {sel && (
                  <>
                    {/* Ticket — captured as PNG (matches website receipt layout) */}
                    <ViewShot ref={receiptRef} options={{ format: 'png', quality: 1, result: 'tmpfile' }} style={s.ticket} collapsable={false}>
                      {/* Top accent bar */}
                      <View style={s.topAccent} />

                      {/* Header */}
                      <View style={s.ticketHeader}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.brandText}>
                            <Text style={{ color: COLORS.primary }}>LC</Text>
                            <Text style={{ color: COLORS.accent }}>space</Text>
                          </Text>
                          <Text style={s.brandSub}>University of Southern Philippines Foundation</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={s.receiptLabel}>BOOKING RECEIPT</Text>
                          <View style={s.idPillSmall}>
                            <Text style={s.idPillSmallText}>{sel.id || sel.docId?.slice(0, 8).toUpperCase()}</Text>
                          </View>
                        </View>
                      </View>

                      {/* Status banner */}
                      {(sel.status === 'Confirmed' || sel.status === 'Checked-In') && (
                        <View style={s.statusBanner}>
                          <View style={s.statusIcon}>
                            <Check size={13} color="#FFFFFF" strokeWidth={3} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={s.statusTitle}>{sel.status === 'Checked-In' ? 'Checked In — Booking Active' : 'Approved & Confirmed'}</Text>
                            <Text style={s.statusSubtitle}>
                              {sel.status === 'Checked-In' ? 'You are currently checked in.' : 'Your reservation has been confirmed by admin'}
                            </Text>
                          </View>
                        </View>
                      )}

                      {/* Reservation Details with seal watermark */}
                      <View style={s.detailsWrap}>
                        <Text style={s.sectionLabel}>RESERVATION DETAILS</Text>
                        <View style={s.detailsDivider} />

                        <View style={s.detailsBody} collapsable={false}>
                          <View pointerEvents="none" style={s.sealBehind} collapsable={false}>
                            <View style={[s.sealLayer, { transform: [{ translateX: -0.6 }, { translateY: -0.6 }] }]} collapsable={false}>
                              <SealSvg color="#FFFFFF" opacity={0.9} />
                            </View>
                            <View style={[s.sealLayer, { transform: [{ translateX: 0.6 }, { translateY: 0.6 }] }]} collapsable={false}>
                              <SealSvg color="#9CA3AF" opacity={0.35} />
                            </View>
                            <SealSvg color="#B6BAC2" opacity={0.55} />
                          </View>

                          {[
                            ['Facility', sel.room_name],
                            ['Date', fmtDate(sel.booking_date)],
                            ['Time Slot', sel.time],
                            ['Purpose', sel.purpose || '—'],
                            ['Group Size', `${sel.group_size || 1} person(s)`],
                            ...(sel.confirmed_at ? [['Confirmed At', fmtStamp(sel.confirmed_at)]] : []),
                          ].map(([label, value], i, arr) => (
                            <View key={label} style={[s.detailRowNew, i < arr.length - 1 && s.detailRowDivider]}>
                              <Text style={s.detailLabelNew}>{label}</Text>
                              <Text style={s.detailValueNew} numberOfLines={2}>{value}</Text>
                            </View>
                          ))}
                        </View>

                        {/* Microprint */}
                        <Text style={s.microprint} numberOfLines={1}>
                          {`uspf · lcspace · ${sel.booking_date} · verified · official · receipt`}
                        </Text>
                      </View>

                      {/* Student card */}
                      <View style={s.studentCard}>
                        <Text style={s.studentLabel}>STUDENT</Text>
                        <Text style={s.studentName}>{sel.student_name || 'Student'}</Text>
                        <Text style={s.studentId}>ID: {sel.student_id || '—'}</Text>
                      </View>

                      {/* Footer */}
                      <View style={s.ticketFooterNew}>
                        <Text style={s.ticketFooterText}>LCspace · USPF Learning Commons</Text>
                        <Text style={s.ticketFooterText}>{new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                      </View>
                    </ViewShot>

                    {/* Download button */}
                    <TouchableOpacity
                      onPress={handleDownload}
                      style={s.downloadBtn}
                      disabled={downloading}
                      activeOpacity={0.85}
                    >
                      {downloading
                        ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.downloadBtnText, { marginLeft: 6 }]}>Downloading…</Text></>
                        : <>
                          <Download size={16} color={COLORS.primary} />
                          <Text style={s.downloadBtnText}>Download as PNG</Text>
                        </>
                      }
                    </TouchableOpacity>

                  </>
                )}
              </ScrollView>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>

        {/* ── Cyberspace Access Modal ── */}
        <CyberspaceAccessModal
          visible={!!cyberspaceBooking}
          booking={cyberspaceBooking}
          onClose={() => setCyberspaceBooking(null)}
          onEnter={(bookingId) => {
            setCyberspaceBooking(null)
            navigation.navigate('Cyberspace', { bookingId })
          }}
        />

        <AlertHost />
      </SafeAreaView>
    </View>
  )
}

// Embossed seal — single-color SVG so we can stack it 3× (highlight / shadow / main) for the raised effect
function SealSvg({ color, opacity = 1 }) {
  const ringText = '★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  ★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  '
  return (
    <Svg width={130} height={130} viewBox="0 0 130 130">
      <Defs>
        {/* Path for curved top text — clockwise arc */}
        <Path id="ringPath" d="M 65 65 m -50 0 a 50 50 0 1 1 100 0 a 50 50 0 1 1 -100 0" fill="none" />
      </Defs>
      <G opacity={opacity}>
        {/* Outer rings */}
        <Circle cx="65" cy="65" r="59" fill="none" stroke={color} strokeWidth="1" />
        <Circle cx="65" cy="65" r="54" fill="none" stroke={color} strokeWidth="0.6" />
        {/* Dotted decorative ring */}
        <Circle cx="65" cy="65" r="49" fill="none" stroke={color} strokeWidth="0.5" strokeDasharray="0.6 2.4" />
        {/* Curved text around the ring */}
        <SvgText fill={color} fontSize="6.2" fontWeight="900" letterSpacing="1.6">
          <TextPath href="#ringPath" startOffset="0%">{ringText}</TextPath>
        </SvgText>
        {/* Inner medallion */}
        <Circle cx="65" cy="65" r="26" fill="none" stroke={color} strokeWidth="0.9" />
        <Circle cx="65" cy="65" r="23" fill="none" stroke={color} strokeWidth="0.4" />
        {/* Side stars beside monogram */}
        <SvgText x="36" y="69" fill={color} fontSize="7" fontWeight="bold" textAnchor="middle">✦</SvgText>
        <SvgText x="94" y="69" fill={color} fontSize="7" fontWeight="bold" textAnchor="middle">✦</SvgText>
        {/* Center monogram */}
        <SvgText x="65" y="68" fill={color} fontSize="18" fontWeight="900" textAnchor="middle" letterSpacing="-0.5">LC</SvgText>
        <SvgText x="65" y="80" fill={color} fontSize="4.2" fontWeight="bold" textAnchor="middle" letterSpacing="2">USPF</SvgText>
        {/* Top + bottom hairline marks */}
        <SvgText x="65" y="48" fill={color} fontSize="3.6" fontWeight="bold" textAnchor="middle" letterSpacing="1.6">EST · LEARNING · COMMONS</SvgText>
        <SvgText x="65" y="90" fill={color} fontSize="3.6" fontWeight="bold" textAnchor="middle" letterSpacing="1.6">AUTHENTICATED · VERIFIED</SvgText>
      </G>
    </Svg>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.primary },

  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18 },
  headerLabel: { fontSize: 10, ...FONTS.bold, color: 'rgba(245,201,0,0.7)', letterSpacing: 1.5, marginBottom: 2 },
  headerTitle: { fontSize: 22, ...FONTS.extrabold, color: COLORS.white },

  filterWrap: { backgroundColor: COLORS.white, paddingVertical: 12, flexGrow: 0, borderBottomWidth: 1, borderBottomColor: COLORS.gray100 },
  filterRow: { paddingHorizontal: 16, gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: COLORS.gray100, borderWidth: 1, borderColor: COLORS.gray200 },
  chipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  chipText: { fontSize: 12, ...FONTS.semibold, color: COLORS.gray500 },
  chipTextActive: { color: COLORS.primary },
  chipBadge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: COLORS.gray200, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  chipBadgeActive: { backgroundColor: 'rgba(38,35,103,0.2)' },
  chipBadgeText: { fontSize: 10, ...FONTS.bold, color: COLORS.gray500 },
  chipBadgeTextActive: { color: COLORS.primary },

  scroll: { flex: 1, backgroundColor: '#F0F2F8' },
  list: { padding: 16, paddingBottom: 104, gap: 12 },

  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyIconWrap: { width: 64, height: 64, borderRadius: 20, backgroundColor: COLORS.white, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2, marginBottom: 4 },
  emptyTitle: { fontSize: 15, ...FONTS.semibold, color: COLORS.gray600 },
  emptySubtitle: { fontSize: 13, color: COLORS.gray400 },

  // ── Cards ──
  card: { backgroundColor: COLORS.white, borderRadius: 16, flexDirection: 'row', overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 3 },
  cardStripe: { width: 5 },
  cardInner: { flex: 1, padding: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  roomName: { fontSize: 14, ...FONTS.bold, color: COLORS.gray900, marginBottom: 3 },
  purposeText: { fontSize: 12, color: COLORS.gray400 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, flexShrink: 0 },
  statusText: { fontSize: 10, ...FONTS.bold },
  metaRow: { flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap' },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EEF0FA', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7 },
  metaText: { fontSize: 11, color: COLORS.primary, ...FONTS.semibold },
  confirmedAtText: { fontSize: 10, ...FONTS.medium, marginTop: 8 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTopWidth: 1, borderTopColor: COLORS.gray100 },
  bookingId: { fontSize: 10, color: COLORS.gray400, fontFamily: 'monospace', letterSpacing: 0.5 },
  cardActions: { flexDirection: 'row', gap: 8 },
  receiptBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#EEF0FA' },
  receiptBtnText: { fontSize: 12, ...FONTS.semibold, color: COLORS.primary },
  cyberBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: COLORS.primary },
  cyberBtnText: { fontSize: 12, ...FONTS.bold, color: COLORS.white },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#FEE2E2' },
  cancelText: { fontSize: 12, ...FONTS.semibold, color: COLORS.red },
  deleteBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: COLORS.gray100, justifyContent: 'center', alignItems: 'center' },

  // ── Receipt lightbox ──
  lightboxOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  lightboxContent: { width: '100%', maxWidth: 400 },
  modalBody: { paddingBottom: 8 },

  // ── Ticket (matches website receipt layout) ──
  ticket: { backgroundColor: COLORS.white, borderRadius: 20, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 16, elevation: 5, marginBottom: 16 },
  topAccent: { height: 4, backgroundColor: COLORS.primary },

  ticketHeader: { flexDirection: 'row', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.gray100, alignItems: 'flex-start' },
  brandText: { fontSize: 19, ...FONTS.extrabold, letterSpacing: -0.5 },
  brandSub: { fontSize: 10, color: COLORS.gray400, marginTop: 2, lineHeight: 13 },
  receiptLabel: { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 6 },
  idPillSmall: { backgroundColor: '#E8E6F7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
  idPillSmallText: { fontSize: 11, ...FONTS.bold, color: COLORS.primary, fontFamily: 'monospace', letterSpacing: 0.5 },

  statusBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 18, marginTop: 14, marginBottom: 4, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  statusIcon: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#22C55E', justifyContent: 'center', alignItems: 'center' },
  statusTitle: { fontSize: 13, ...FONTS.extrabold, color: '#15803D', lineHeight: 16 },
  statusSubtitle: { fontSize: 10, color: '#16A34A', marginTop: 2 },

  detailsWrap: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  sectionLabel: { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 6 },
  detailsDivider: { height: 1, backgroundColor: COLORS.gray100, marginBottom: 4 },
  detailsBody: { position: 'relative', overflow: 'hidden' },
  sealBehind: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', zIndex: 0 },

  detailRowNew: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 11 },
  detailRowDivider: { borderBottomWidth: 1, borderBottomColor: '#F9FAFB' },
  detailLabelNew: { fontSize: 11, color: COLORS.gray400, ...FONTS.medium, width: 80 },
  detailValueNew: { fontSize: 13, ...FONTS.bold, color: COLORS.gray900, flex: 1, textAlign: 'right' },

  microprint: { fontSize: 8, color: COLORS.gray400, ...FONTS.medium, fontFamily: 'monospace', letterSpacing: 0.5, textAlign: 'center', marginTop: 10, marginBottom: 4 },

  studentCard: { marginHorizontal: 18, marginTop: 6, marginBottom: 14, backgroundColor: COLORS.gray50, borderWidth: 1, borderColor: COLORS.gray100, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  studentLabel: { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 5 },
  studentName: { fontSize: 14, ...FONTS.extrabold, color: COLORS.gray900 },
  studentId: { fontSize: 11, color: COLORS.gray500, marginTop: 2 },

  ticketFooterNew: { backgroundColor: COLORS.gray50, borderTopWidth: 1, borderTopColor: COLORS.gray100, paddingHorizontal: 18, paddingVertical: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ticketFooterText: { fontSize: 9, color: COLORS.gray400, ...FONTS.medium },

  // Embossed seal layer (stacked 3× behind details)
  sealLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },

  downloadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 14, marginTop: 12 },
  downloadBtnText: { fontSize: 15, ...FONTS.bold, color: COLORS.primary },

  cancelFromReceiptBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#FEE2E2', borderRadius: 16, paddingVertical: 14, marginBottom: 10 },
  cancelFromReceiptText: { fontSize: 14, ...FONTS.semibold, color: COLORS.red },
  deleteFromReceiptBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.gray100, borderRadius: 16, paddingVertical: 14 },
  deleteFromReceiptText: { fontSize: 14, ...FONTS.semibold, color: COLORS.gray500 },
})
