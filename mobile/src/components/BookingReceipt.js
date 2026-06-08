import { forwardRef } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import Svg, { Defs, Path, Circle, G, Text as SvgText, TextPath } from 'react-native-svg'
import ViewShot from 'react-native-view-shot'
import { Check } from 'lucide-react-native'
import { COLORS, FONTS } from '../lib/theme'

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

// Embossed seal — single-color SVG stacked 3× (highlight / shadow / main) for a raised effect
export function SealSvg({ color, opacity = 1 }) {
  const ringText = '★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  ★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  '
  return (
    <Svg width={130} height={130} viewBox="0 0 130 130">
      <Defs>
        <Path id="ringPath" d="M 65 65 m -50 0 a 50 50 0 1 1 100 0 a 50 50 0 1 1 -100 0" fill="none" />
      </Defs>
      <G opacity={opacity}>
        <Circle cx="65" cy="65" r="59" fill="none" stroke={color} strokeWidth="1" />
        <Circle cx="65" cy="65" r="54" fill="none" stroke={color} strokeWidth="0.6" />
        <Circle cx="65" cy="65" r="49" fill="none" stroke={color} strokeWidth="0.5" strokeDasharray="0.6 2.4" />
        <SvgText fill={color} fontSize="6.2" fontWeight="900" letterSpacing="1.6">
          <TextPath href="#ringPath" startOffset="0%">{ringText}</TextPath>
        </SvgText>
        <Circle cx="65" cy="65" r="26" fill="none" stroke={color} strokeWidth="0.9" />
        <Circle cx="65" cy="65" r="23" fill="none" stroke={color} strokeWidth="0.4" />
        <SvgText x="36" y="69" fill={color} fontSize="7" fontWeight="bold" textAnchor="middle">✦</SvgText>
        <SvgText x="94" y="69" fill={color} fontSize="7" fontWeight="bold" textAnchor="middle">✦</SvgText>
        <SvgText x="65" y="68" fill={color} fontSize="18" fontWeight="900" textAnchor="middle" letterSpacing="-0.5">LC</SvgText>
        <SvgText x="65" y="80" fill={color} fontSize="4.2" fontWeight="bold" textAnchor="middle" letterSpacing="2">USPF</SvgText>
        <SvgText x="65" y="48" fill={color} fontSize="3.6" fontWeight="bold" textAnchor="middle" letterSpacing="1.6">EST · LEARNING · COMMONS</SvgText>
        <SvgText x="65" y="90" fill={color} fontSize="3.6" fontWeight="bold" textAnchor="middle" letterSpacing="1.6">AUTHENTICATED · VERIFIED</SvgText>
      </G>
    </Svg>
  )
}

/**
 * Shared, official booking receipt — used on the Reserve success screen and in
 * My Bookings. Wrap in a ViewShot via the forwarded ref to capture as PNG.
 *
 * booking: { id|docId, student_name, student_id, room_name, booking_date,
 *            time, purpose, group_size, status, confirmed_at }
 */
const BookingReceipt = forwardRef(function BookingReceipt({ booking }, ref) {
  const b = booking || {}
  const showBanner = b.status === 'Confirmed' || b.status === 'Checked-In'
  return (
    <ViewShot ref={ref} options={{ format: 'png', quality: 1, result: 'tmpfile' }} style={s.ticket} collapsable={false}>
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
            <Text style={s.idPillSmallText}>{b.id || b.docId?.slice(0, 8).toUpperCase() || '—'}</Text>
          </View>
        </View>
      </View>

      {/* Status banner */}
      {showBanner && (
        <View style={s.statusBanner}>
          <View style={s.statusIcon}><Check size={13} color="#FFFFFF" strokeWidth={3} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.statusTitle}>{b.status === 'Checked-In' ? 'Checked In — Booking Active' : 'Approved & Confirmed'}</Text>
            <Text style={s.statusSubtitle}>
              {b.status === 'Checked-In' ? 'You are currently checked in.' : 'Your reservation has been confirmed by admin'}
            </Text>
          </View>
        </View>
      )}

      {/* Reservation details with seal watermark */}
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
            ['Facility',    b.room_name],
            ['Date',        fmtDate(b.booking_date)],
            ['Time Slot',   b.time],
            ['Purpose',     b.purpose || '—'],
            ['Group Size',  `${b.group_size || 1} person(s)`],
            ...(b.confirmed_at ? [['Confirmed At', fmtStamp(b.confirmed_at)]] : []),
          ].map(([label, value], i, arr) => (
            <View key={label} style={[s.detailRow, i < arr.length - 1 && s.detailRowDivider]}>
              <Text style={s.detailLabel}>{label}</Text>
              <Text style={s.detailValue} numberOfLines={2}>{value}</Text>
            </View>
          ))}
        </View>

        <Text style={s.microprint} numberOfLines={1}>
          {`uspf · lcspace · ${b.booking_date || ''} · verified · official · receipt`}
        </Text>
      </View>

      {/* Student card */}
      <View style={s.studentCard}>
        <Text style={s.studentLabel}>STUDENT</Text>
        <Text style={s.studentName}>{b.student_name || 'Student'}</Text>
        <Text style={s.studentId}>ID: {b.student_id || '—'}</Text>
      </View>

      {/* Footer */}
      <View style={s.ticketFooter}>
        <Text style={s.ticketFooterText}>LCspace · USPF Learning Commons</Text>
        <Text style={s.ticketFooterText}>{new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
      </View>
    </ViewShot>
  )
})

export default BookingReceipt

const s = StyleSheet.create({
  ticket:        { backgroundColor: COLORS.white, borderRadius: 20, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 16, elevation: 5, marginBottom: 16 },
  topAccent:     { height: 4, backgroundColor: COLORS.primary },
  ticketHeader:  { flexDirection: 'row', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.gray100, alignItems: 'flex-start' },
  brandText:     { fontSize: 19, ...FONTS.extrabold, letterSpacing: -0.5 },
  brandSub:      { fontSize: 10, color: COLORS.gray400, marginTop: 2, lineHeight: 13 },
  receiptLabel:  { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 6 },
  idPillSmall:   { backgroundColor: '#E8E6F7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
  idPillSmallText:{ fontSize: 11, ...FONTS.bold, color: COLORS.primary, fontFamily: 'monospace', letterSpacing: 0.5 },

  statusBanner:  { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 18, marginTop: 14, marginBottom: 4, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  statusIcon:    { width: 26, height: 26, borderRadius: 13, backgroundColor: '#22C55E', justifyContent: 'center', alignItems: 'center' },
  statusTitle:   { fontSize: 13, ...FONTS.extrabold, color: '#15803D', lineHeight: 16 },
  statusSubtitle:{ fontSize: 10, color: '#16A34A', marginTop: 2 },

  detailsWrap:   { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  sectionLabel:  { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 6 },
  detailsDivider:{ height: 1, backgroundColor: COLORS.gray100, marginBottom: 4 },
  detailsBody:   { position: 'relative', overflow: 'hidden' },
  sealBehind:    { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', zIndex: 0 },
  sealLayer:     { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },

  detailRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 11 },
  detailRowDivider:{ borderBottomWidth: 1, borderBottomColor: '#F9FAFB' },
  detailLabel:     { fontSize: 11, color: COLORS.gray400, ...FONTS.medium, width: 90 },
  detailValue:     { fontSize: 13, ...FONTS.bold, color: COLORS.gray900, flex: 1, textAlign: 'right' },

  microprint:    { fontSize: 8, color: COLORS.gray400, ...FONTS.medium, fontFamily: 'monospace', letterSpacing: 0.5, textAlign: 'center', marginTop: 10, marginBottom: 4 },

  studentCard:   { marginHorizontal: 18, marginTop: 6, marginBottom: 14, backgroundColor: COLORS.gray50, borderWidth: 1, borderColor: COLORS.gray100, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  studentLabel:  { fontSize: 9, ...FONTS.bold, color: COLORS.gray400, letterSpacing: 1.6, marginBottom: 5 },
  studentName:   { fontSize: 14, ...FONTS.extrabold, color: COLORS.gray900 },
  studentId:     { fontSize: 11, color: COLORS.gray500, marginTop: 2 },

  ticketFooter:  { backgroundColor: COLORS.gray50, borderTopWidth: 1, borderTopColor: COLORS.gray100, paddingHorizontal: 18, paddingVertical: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ticketFooterText:{ fontSize: 9, color: COLORS.gray400, ...FONTS.medium },
})
