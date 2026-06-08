import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { signOut, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, setDoc, deleteDoc, updateDoc, collection, query, where, getDocs, serverTimestamp, onSnapshot, orderBy, addDoc, Timestamp } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import {
  LayoutDashboard, Calendar, ClipboardList, Monitor, BookOpen,
  LogOut, Lock, AlertTriangle, AlertCircle, CheckCircle2, Building2,
  Clock, CalendarClock, ChevronRight, Users, Shield, Check, Wrench, Megaphone, Trash2, Settings, Mail, HelpCircle, Send, Plus, MailOpen, RefreshCw, Camera, X, Timer, BellRing,
  Sun, Moon, CalendarDays, Info, MapPin, Wifi, Power, Coffee, ShieldCheck, AlertOctagon, ChevronDown, ChevronUp, Sparkles, Download,
  PenLine, MessageSquare, ScreenShare, UserPlus, Scale
} from 'lucide-react'
import LoadingScreen from '../components/LoadingScreen'
import NotificationBell from '../components/NotificationBell'
import AlertModal from '../components/AlertModal'
import { toPng } from 'html-to-image'
import { checkRateLimit, formatRetryAfter } from '../lib/rateLimit'
import { sanitizeText } from '../lib/validation'
import { sha256, genId } from '../lib/crypto'
import { ThemeProvider, useTheme } from '../lib/ThemeContext'

const CANCEL_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
// TEMP (testing): when true, the Cyberspace button opens the session directly,
// bypassing the booking / confirmed / checked-in / time-window / access-code gates.
// Set back to false to restore normal access control.
const CYBERSPACE_TEST_MODE = true
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ── Time-slot parser ─────────────────────────────────────────────────────────
// Parses a slot like '8:00 AM – 10:00 AM' into { startMs, endMs } for today
// Parses a slot like '8:00 AM – 10:00 AM' into { startMs, endMs } for a given date
function parseTimeSlot(slotStr, dateStr) {
  if (!slotStr) return null
  // normalise dash variants: – — - to a common separator
  const parts = slotStr.replace(/\u2013|\u2014|\u2012/g, '-').split('-').map(s => s.trim())
  if (parts.length < 2) return null
  const toMs = (str) => {
    const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i)
    if (!m) return null
    let h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    const period = m[3].toUpperCase()
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    // Parse dateStr (YYYY-MM-DD) carefully to avoid timezone shifts
    let d
    if (dateStr) {
      const [y, mm, dd] = dateStr.split('-').map(Number)
      d = new Date(y, mm - 1, dd)
    } else {
      d = new Date()
    }
    d.setHours(h, min, 0, 0)
    return d.getTime()
  }
  const startMs = toMs(parts[0])
  const endMs = toMs(parts[1])
  if (!startMs || !endMs) return null
  return { startMs, endMs }
}

// ── Receipt download — captures the receipt DOM so PNG matches the modal exactly ──
async function downloadReceipt(booking, node) {
  if (!node) return
  // Temporarily lift max-height + scroll so html-to-image captures the full receipt
  const prevMaxHeight = node.style.maxHeight
  const prevOverflow = node.style.overflow
  node.style.maxHeight = 'none'
  node.style.overflow = 'visible'
  try {
    const dataUrl = await toPng(node, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      cacheBust: true,
    })
    const link = document.createElement('a')
    link.download = `LCspace_Receipt_${booking.id || 'booking'}.png`
    link.href = dataUrl
    link.click()
  } catch (err) {
    console.error('Receipt download failed:', err)
  } finally {
    node.style.maxHeight = prevMaxHeight
    node.style.overflow = prevOverflow
  }
}

// Legacy canvas fallback (kept available, currently unused) ────────────────────
function downloadReceiptCanvas(booking) {
  const scale = 2
  const W = 520, H = 620
  const canvas = document.createElement('canvas')
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  const PAD = 28

  function rr(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r)
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h)
    ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r); ctx.closePath()
  }

  // White background
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)

  // Top accent bar
  ctx.fillStyle = '#262367'; ctx.fillRect(0, 0, W, 6)

  // ── Header ──────────────────────────────────
  ctx.font = 'bold 22px Arial, sans-serif'
  ctx.fillStyle = '#262367'; ctx.fillText('LC', PAD, 52)
  const lcW = ctx.measureText('LC').width
  ctx.fillStyle = '#F5C900'; ctx.fillText('space', PAD + lcW, 52)
  ctx.font = '10px Arial, sans-serif'
  ctx.fillStyle = '#9ca3af'; ctx.fillText('University of Southern Philippines Foundation', PAD, 70)
  ctx.font = 'bold 9px Arial, sans-serif'
  ctx.fillStyle = '#9ca3af'
  const rcLabel = 'BOOKING RECEIPT'
  const rcW = ctx.measureText(rcLabel).width
  ctx.fillText(rcLabel, W - PAD - rcW, 46)
  ctx.font = 'bold 11px "Courier New", monospace'
  ctx.fillStyle = '#262367'
  const idStr = booking.id || '—'
  const idW = ctx.measureText(idStr).width
  ctx.fillStyle = '#e8e6f7'; rr(W - PAD - idW - 14, 54, idW + 14, 22, 5); ctx.fill()
  ctx.fillStyle = '#262367'; ctx.fillText(idStr, W - PAD - idW - 7, 69)

  // Header divider
  ctx.fillStyle = '#f3f4f6'; ctx.fillRect(0, 94, W, 1)

  // ── Status badge ─────────────────────────────
  ctx.fillStyle = '#f0fdf4'; rr(PAD, 108, W - PAD * 2, 52, 10); ctx.fill()
  ctx.strokeStyle = '#bbf7d0'; ctx.lineWidth = 1; rr(PAD, 108, W - PAD * 2, 52, 10); ctx.stroke()
  // Circle
  ctx.fillStyle = '#22c55e'
  ctx.beginPath(); ctx.arc(PAD + 28, 134, 12, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(PAD + 22, 134); ctx.lineTo(PAD + 27, 139); ctx.lineTo(PAD + 35, 128); ctx.stroke()
  ctx.font = 'bold 13px Arial, sans-serif'
  ctx.fillStyle = '#15803d'; ctx.fillText('Approved & Confirmed', PAD + 48, 139)

  // ── Embossed authenticity seal (drawn BEHIND the reservation details) ──
  function drawSeal(cx, cy, baseColor, alpha) {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = baseColor
    ctx.fillStyle = baseColor

    // Outer rings
    ctx.lineWidth = 1.4
    ctx.beginPath(); ctx.arc(cx, cy, 78, 0, Math.PI * 2); ctx.stroke()
    ctx.lineWidth = 0.9
    ctx.beginPath(); ctx.arc(cx, cy, 71, 0, Math.PI * 2); ctx.stroke()

    // Dotted decorative ring
    ctx.lineWidth = 1
    ctx.setLineDash([0.8, 3])
    ctx.beginPath(); ctx.arc(cx, cy, 64, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])

    // Curved top text (manual — char by char around the arc)
    function arcText(text, radius, startAngle, endAngle, size) {
      ctx.font = `bold ${size}px Arial, sans-serif`
      const total = endAngle - startAngle
      const step = total / Math.max(text.length, 1)
      for (let i = 0; i < text.length; i++) {
        const ang = startAngle + step * i + step / 2
        ctx.save()
        ctx.translate(cx + Math.cos(ang) * radius, cy + Math.sin(ang) * radius)
        ctx.rotate(ang + Math.PI / 2)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text[i], 0, 0)
        ctx.restore()
      }
    }
    arcText('★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  ★', 68, Math.PI * 1.25, Math.PI * 2.75, 8)

    // Inner medallion
    ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.arc(cx, cy, 34, 0, Math.PI * 2); ctx.stroke()
    ctx.lineWidth = 0.6
    ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.stroke()

    // Side stars
    ctx.font = 'bold 10px Arial, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('✦', cx - 38, cy)
    ctx.fillText('✦', cx + 38, cy)

    // Center monogram
    ctx.font = 'bold 26px Arial, sans-serif'
    ctx.fillText('LC', cx, cy - 2)
    ctx.font = 'bold 6px Arial, sans-serif'
    ctx.fillText('USPF', cx, cy + 16)

    // Top / bottom hairlines
    ctx.font = 'bold 5px Arial, sans-serif'
    ctx.fillText('EST · LEARNING · COMMONS', cx, cy - 24)
    ctx.fillText('AUTHENTICATED · VERIFIED', cx, cy + 28)

    ctx.restore()
  }
  // Embossed feel: white highlight offset, gray shadow offset, mid-gray main
  const sealCx = W / 2, sealCy = 312
  drawSeal(sealCx - 0.8, sealCy - 0.8, '#FFFFFF', 0.55)
  drawSeal(sealCx + 0.8, sealCy + 0.8, '#9CA3AF', 0.25)
  drawSeal(sealCx, sealCy, '#B6BAC2', 0.45)

  // ── Reservation details ───────────────────────
  ctx.font = 'bold 9px Arial, sans-serif'
  ctx.fillStyle = '#9ca3af'; ctx.fillText('RESERVATION DETAILS', PAD, 183)
  ctx.fillStyle = '#f3f4f6'; ctx.fillRect(PAD, 191, W - PAD * 2, 1)

  const fmtDate = d => d ? new Date(d + 'T00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—'
  const rows = [
    ['Facility', booking.room_name || booking.facility || '—'],
    ['Date', fmtDate(booking.booking_date) || booking.date || '—'],
    ['Time Slot', booking.time || '—'],
    ['Purpose', (booking.purpose || '—').slice(0, 44)],
    ['Group Size', String(booking.group_size || 1) + ' person(s)'],
  ]
  rows.forEach(([label, value], i) => {
    const y = 207 + i * 42
    ctx.font = '9px Arial, sans-serif'; ctx.fillStyle = '#9ca3af'; ctx.fillText(label, PAD, y)
    ctx.font = 'bold 12px Arial, sans-serif'; ctx.fillStyle = '#111827'; ctx.fillText(value, PAD, y + 16)
    if (i < rows.length - 1) { ctx.fillStyle = '#f9fafb'; ctx.fillRect(PAD, y + 30, W - PAD * 2, 1) }
  })

  // ── Authenticity microprint ───────────────────
  ctx.font = 'bold 7px "Courier New", monospace'
  ctx.fillStyle = '#9ca3af'
  ctx.textAlign = 'center'
  const microStr = `uspf · lcspace · ${booking.booking_date || booking.date || ''} · verified · official · receipt`
  ctx.fillText(microStr, W / 2, 416)
  ctx.textAlign = 'left'

  // ── Student card ──────────────────────────────
  const sY = 428
  ctx.fillStyle = '#f9fafb'; rr(PAD, sY, W - PAD * 2, 86, 10); ctx.fill()
  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1; rr(PAD, sY, W - PAD * 2, 86, 10); ctx.stroke()
  ctx.font = 'bold 9px Arial, sans-serif'; ctx.fillStyle = '#9ca3af'; ctx.fillText('STUDENT', PAD + 18, sY + 22)
  ctx.font = 'bold 14px Arial, sans-serif'; ctx.fillStyle = '#111827'; ctx.fillText(booking.student_name || booking.name || 'Student', PAD + 18, sY + 44)
  ctx.font = '11px Arial, sans-serif'; ctx.fillStyle = '#6b7280'; ctx.fillText('ID: ' + (booking.student_id || '—'), PAD + 18, sY + 62)

  // ── Footer ────────────────────────────────────
  ctx.fillStyle = '#f9fafb'; ctx.fillRect(0, 530, W, H - 530)
  ctx.fillStyle = '#e5e7eb'; ctx.fillRect(0, 530, W, 1)
  ctx.font = '10px Arial, sans-serif'; ctx.fillStyle = '#9ca3af'
  ctx.fillText('LCspace · USPF Learning Commons', PAD, 558)
  const genStr = 'Generated: ' + new Date().toLocaleString()
  const genW = ctx.measureText(genStr).width
  ctx.fillText(genStr, W - PAD - genW, 558)
  ctx.fillText('This receipt is valid only for the reservation stated above.', PAD, 580)

  const link = document.createElement('a')
  link.download = `LCspace_Receipt_${booking.id || 'booking'}.png`
  link.href = canvas.toDataURL('image/png')
  link.click()
}

// ── Receipt preview modal ─────────────────────────────────────────────────────
function ReceiptSeal({ size = 160 }) {
  const ringText = '★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  ★  OFFICIAL  ·  USPF  ·  LCSPACE  ·  LEARNING COMMONS  '
  const color = '#B6BAC2'
  return (
    <svg width={size} height={size} viewBox="0 0 130 130" style={{ opacity: 0.55 }}>
      <defs>
        <path id="receipt-seal-ring" d="M 65 65 m -50 0 a 50 50 0 1 1 100 0 a 50 50 0 1 1 -100 0" fill="none" />
      </defs>
      <circle cx="65" cy="65" r="59" fill="none" stroke={color} strokeWidth="1" />
      <circle cx="65" cy="65" r="54" fill="none" stroke={color} strokeWidth="0.6" />
      <circle cx="65" cy="65" r="49" fill="none" stroke={color} strokeWidth="0.5" strokeDasharray="0.6 2.4" />
      <text fill={color} fontSize="6.2" fontWeight="900" letterSpacing="1.6">
        <textPath href="#receipt-seal-ring" startOffset="0%">{ringText}</textPath>
      </text>
      <circle cx="65" cy="65" r="26" fill="none" stroke={color} strokeWidth="0.9" />
      <circle cx="65" cy="65" r="23" fill="none" stroke={color} strokeWidth="0.4" />
      <text x="36" y="69" fill={color} fontSize="7" fontWeight="bold" textAnchor="middle">✦</text>
      <text x="94" y="69" fill={color} fontSize="7" fontWeight="bold" textAnchor="middle">✦</text>
      <text x="65" y="68" fill={color} fontSize="18" fontWeight="900" textAnchor="middle" letterSpacing="-0.5">LC</text>
      <text x="65" y="80" fill={color} fontSize="4.2" fontWeight="bold" textAnchor="middle" letterSpacing="2">USPF</text>
      <text x="65" y="48" fill={color} fontSize="3.6" fontWeight="bold" textAnchor="middle" letterSpacing="1.6">EST · LEARNING · COMMONS</text>
      <text x="65" y="90" fill={color} fontSize="3.6" fontWeight="bold" textAnchor="middle" letterSpacing="1.6">AUTHENTICATED · VERIFIED</text>
    </svg>
  )
}

function ReceiptModal({ booking, onClose }) {
  const receiptRef = useRef(null)
  const generated = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  const fmtDate = d => d ? new Date(d + 'T00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null
  const fmtStamp = ts => {
    if (!ts) return null
    const ms = ts?.seconds ? ts.seconds * 1000 : new Date(ts).getTime()
    if (!ms || isNaN(ms)) return null
    return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
  const confirmedAtStr = fmtStamp(booking.confirmed_at)
  const details = [
    ['Facility', booking.room_name || booking.facility || '—'],
    ['Date', fmtDate(booking.booking_date) || booking.date || '—'],
    ['Time Slot', booking.time || '—'],
    ['Purpose', booking.purpose || '—'],
    ['Group Size', `${booking.group_size || 1} person(s)`],
    ...(confirmedAtStr ? [['Confirmed At', confirmedAtStr]] : []),
  ]
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="flex flex-col items-center gap-4 max-h-[90vh]">

        {/* Receipt card */}
        <div ref={receiptRef} className="bg-white w-[420px] rounded-2xl overflow-hidden shadow-2xl border border-white/10 flex-shrink-0 max-h-[75vh] overflow-y-auto">

          {/* Top accent */}
          <div className="h-1.5 bg-[#262367] flex-shrink-0" />

          {/* Header */}
          <div className="px-6 pt-5 pb-4 flex items-start justify-between border-b border-gray-100">
            <div>
              <p className="text-lg font-black tracking-tight leading-none">
                <span className="text-[#262367]">LC</span>
                <span className="text-[#F5C900]">space</span>
              </p>
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">University of Southern Philippines Foundation</p>
            </div>
            <div className="text-right flex-shrink-0 ml-4">
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Booking Receipt</p>
              <p className="font-mono text-[11px] font-bold text-[#262367] mt-1.5 bg-[#262367]/8 px-2 py-0.5 rounded inline-block">
                {booking.id || '—'}
              </p>
            </div>
          </div>

          {/* Status */}
          <div className="px-6 pt-4 pb-3">
            <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
              <div className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
              </div>
              <div>
                <p className="text-sm font-bold text-green-700 leading-none">Approved & Confirmed</p>
                <p className="text-[10px] text-green-600 mt-0.5">Your reservation has been confirmed by admin</p>
              </div>
            </div>
          </div>

          {/* Details with embossed seal watermark behind */}
          <div className="px-6 pb-4 relative overflow-hidden">
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              aria-hidden="true"
              style={{ filter: 'drop-shadow(-0.6px -0.6px 0 rgba(255,255,255,0.9)) drop-shadow(0.6px 0.6px 0 rgba(156,163,175,0.5))' }}
            >
              <ReceiptSeal size={170} />
            </div>
            <div className="relative">
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-3">Reservation Details</p>
              <div className="divide-y divide-gray-50">
                {details.map(([label, value]) => (
                  <div key={label} className="py-2.5 flex items-center justify-between gap-4">
                    <p className="text-[10px] text-gray-400 font-medium flex-shrink-0">{label}</p>
                    <p className="text-xs font-semibold text-gray-800 text-right">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Microprint authenticity line */}
          <p className="px-6 text-center text-[8px] font-mono text-gray-400 tracking-wider mb-3">
            {`uspf · lcspace · ${booking.booking_date || booking.date || ''} · verified · official · receipt`}
          </p>

          {/* Student */}
          <div className="mx-6 mb-5 bg-gray-50 rounded-xl px-4 py-3 border border-gray-100">
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Student</p>
            <p className="text-sm font-bold text-gray-900">{booking.student_name || booking.name || 'Student'}</p>
            <p className="text-xs text-gray-500 mt-0.5">ID: {booking.student_id || '—'}</p>
          </div>

          {/* Footer */}
          <div className="px-6 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
            <p className="text-[9px] text-gray-400">LCspace · USPF Learning Commons</p>
            <p className="text-[9px] text-gray-400">{generated}</p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <button onClick={onClose}
            className="px-5 py-2.5 bg-white/10 hover:bg-white/20 text-white text-sm font-medium rounded-xl backdrop-blur-sm transition border border-white/20">
            Close
          </button>
          <button onClick={() => downloadReceipt(booking, receiptRef.current)}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#262367] hover:bg-[#35318c] text-white text-sm font-bold rounded-xl shadow-lg shadow-[#262367]/40 transition">
            <Download size={14} /> Download PNG
          </button>
        </div>
      </div>
    </div>
  )
}

// ── CyberspaceAccessModal ─────────────────────────────────────────────────────
function CyberspaceAccessModal({ state, booking, hasPendingBooking, onClose, onPasswordSuccess }) {
  const [pwInput, setPwInput] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwVerifying, setPwVerifying] = useState(false)

  async function verifyPassword(e) {
    e.preventDefault()
    // Student bookings are keyed by `docId`; `firestoreId` is the admin-side name.
    // Accept either so the lookup never silently no-ops.
    const bookingId = booking?.docId || booking?.firestoreId
    if (!pwInput.trim() || !bookingId) return
    setPwVerifying(true)
    setPwError('')
    try {
      const [bookingSnap, inputHash] = await Promise.all([
        getDoc(doc(db, 'bookings', bookingId)),
        sha256(pwInput.trim().toUpperCase()),
      ])
      const data = bookingSnap.data()
      if (!data?.cyberspace_token_hash) {
        setPwError('No access code found for your booking. Please contact the admin desk.')
      } else if (data.cyberspace_token_hash === inputHash) {
        onPasswordSuccess?.()
      } else {
        setPwError('Incorrect code. Please visit the admin desk to get your personal access code.')
      }
    } catch {
      setPwError('Unable to verify. Please check your connection.')
    }
    setPwVerifying(false)
  }

  if (!state) return null

  const variants = {
    too_early: {
      iconBg: 'bg-amber-100',
      icon: <Clock className="w-9 h-9 text-amber-500" />,
      badgeBg: 'bg-amber-100 text-amber-700',
      badgeText: 'Not Yet Available',
      title: 'Session Not Started Yet',
      body: null,
    },
    expired: {
      iconBg: 'bg-red-100',
      icon: <Timer className="w-9 h-9 text-red-500" />,
      badgeBg: 'bg-red-100 text-red-700',
      badgeText: 'Session Expired',
      title: 'Your 2-Hour Session Has Ended',
      body: 'Your reserved time slot has already passed. You can no longer access Cyberspace for this booking. Please make a new reservation for a future slot.',
    },
    no_booking: {
      iconBg: 'bg-[#262367]/10',
      icon: hasPendingBooking
        ? <CalendarClock className="w-9 h-9 text-[#262367]" />
        : <Lock className="w-9 h-9 text-[#262367]" />,
      badgeBg: 'bg-[#262367]/10 text-[#262367]',
      badgeText: hasPendingBooking ? 'No Booking Today' : 'No Reservation',
      title: hasPendingBooking ? 'No Confirmed Booking for Today' : 'Access Restricted',
      body: hasPendingBooking
        ? 'You have an upcoming reservation, but none confirmed for today. Cyberspace access requires an admin-confirmed booking on the current date.'
        : 'You need an admin-confirmed reservation for today to access Cyberspace. Book a facility first, then wait for admin approval.',
    },
    not_confirmed: {
      iconBg: 'bg-blue-100',
      icon: <AlertCircle className="w-9 h-9 text-blue-500" />,
      badgeBg: 'bg-blue-100 text-blue-700',
      badgeText: 'Pending Approval',
      title: 'Awaiting Admin Confirmation',
      body: 'Your reservation is still Pending. Cyberspace access is only granted after an admin confirms your booking.',
    },
    not_checked_in: {
      iconBg: 'bg-orange-100',
      icon: <CheckCircle2 className="w-9 h-9 text-orange-500" />,
      badgeBg: 'bg-orange-100 text-orange-700',
      badgeText: 'Check-In Required',
      title: 'Please Visit the Admin Desk',
      body: 'Your booking is confirmed — but you need to check in with the admin desk first before accessing Cyberspace. Please approach the admin and have them mark your attendance.',
    },
    needs_password: {
      iconBg: 'bg-[#262367]/10',
      icon: <Lock className="w-9 h-9 text-[#262367]" />,
      badgeBg: 'bg-[#262367]/10 text-[#262367]',
      badgeText: 'Access Code Required',
      title: 'Enter Your Personal Access Code',
      body: 'Visit the admin desk and ask for your access code. Each student has a unique code — the admin will look up your booking and read it out to you.',
    },
    library_unavailable: {
      iconBg: 'bg-[#262367]/10',
      icon: <BookOpen className="w-9 h-9 text-[#262367]" />,
      badgeBg: 'bg-[#262367]/10 text-[#262367]',
      badgeText: 'Not Yet Available',
      title: 'Library Catalog Coming Soon',
      body: 'The Library Catalog is not available at the moment. This feature is currently under development and will be accessible in a future update. Please check back later.',
    },
  }

  const v = variants[state]
  if (!v) return null

  // Dynamic body for too_early
  let body = v.body
  if (state === 'too_early' && booking) {
    const slot = parseTimeSlot(booking.time)
    if (slot) {
      const diff = slot.startMs - Date.now()
      const mins = Math.ceil(diff / 60000)
      const hrs = Math.floor(mins / 60)
      const rem = mins % 60
      const countdown = hrs > 0 ? `${hrs}h ${rem}m` : `${mins} min`
      body = `Your Cyberspace session for ${booking.room_name} starts at ${booking.time.split('\u2013')[0].trim()}. Please come back in approximately ${countdown}.`
    } else {
      body = `Your Cyberspace session (${booking.room_name}) hasn't started yet. Check your reserved time slot and return when it begins.`
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-7 flex flex-col items-center text-center relative border border-gray-200"
        style={{ animation: 'fadeInScale 0.18s ease' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3.5 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition"
        >
          <X size={14} className="text-gray-500" />
        </button>

        {/* Icon */}
        <div className={`w-16 h-16 rounded-2xl ${v.iconBg} flex items-center justify-center mb-4`}>
          {v.icon}
        </div>

        {/* Badge */}
        <span className={`text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full ${v.badgeBg} mb-3`}>
          {v.badgeText}
        </span>

        <h2 className="text-lg font-extrabold text-gray-900 mb-2 leading-snug">{v.title}</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-5">{body}</p>

        {/* Booking details row */}
        {booking && state !== 'needs_password' && (
          <div className="w-full bg-gray-50 rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3 mb-5 text-left">
            <div className="w-8 h-8 rounded-lg bg-gray-200 flex items-center justify-center flex-shrink-0">
              <Monitor size={14} className="text-gray-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-gray-900 truncate">{booking.room_name}</p>
              <p className="text-[11px] text-gray-400 truncate">{booking.time}</p>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-gray-200 text-gray-600 flex-shrink-0">
              {booking.status}
            </span>
          </div>
        )}

        {state === 'needs_password' ? (
          <form onSubmit={verifyPassword} className="w-full space-y-3">
            <input
              type="text"
              value={pwInput}
              onChange={e => { setPwInput(e.target.value.toUpperCase()); setPwError('') }}
              placeholder="Enter access code"
              autoComplete="off"
              maxLength={8}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl font-mono text-base font-bold tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-[#262367]/30 focus:border-[#262367] transition"
            />
            {pwError && (
              <p className="text-xs text-red-500 text-center leading-snug">{pwError}</p>
            )}
            <button type="submit" disabled={pwVerifying || !pwInput.trim()}
              className="w-full py-2.5 rounded-xl bg-[#262367] text-white text-sm font-bold hover:bg-[#35318c] transition disabled:opacity-50 flex items-center justify-center gap-2">
              {pwVerifying
                ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : 'Unlock Cyberspace'}
            </button>
            <button type="button" onClick={onClose}
              className="w-full py-2 text-xs text-gray-400 hover:text-gray-600 transition">
              Cancel
            </button>
          </form>
        ) : (
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-[#262367] text-white text-sm font-bold hover:bg-[#35318c] transition"
          >
            Got it
          </button>
        )}
      </div>
    </div>
  )
}
function AppealStrikesModal({ profile, onClose, isOpen, pendingAppeal }) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const strikes = profile?.strike_count ?? 0
  const noStrikes = strikes === 0

  if (!isOpen) return null

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!reason.trim() || noStrikes || pendingAppeal || submitting) return
    setSubmitting(true)
    try {
      await addDoc(collection(db, 'appeals'), {
        user_id: profile.uid,
        student_id: profile.student_id,
        student_name: profile.name,
        student_email: profile.email,
        strike_count: profile.strike_count || 0,
        reason: reason.trim(),
        status: 'pending',
        created_at: serverTimestamp()
      })
      setReason('')
      onClose()
    } catch (err) {
      console.error('Appeal failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-7 flex flex-col items-center text-center relative border border-gray-200"
        style={{ animation: 'fadeInScale 0.18s ease' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3.5 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition"
        >
          <X size={14} className="text-gray-500" />
        </button>

        {noStrikes ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mb-4">
              <ShieldCheck className="w-9 h-9 text-emerald-500" />
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 mb-3">
              Clean Record
            </span>
            <h2 className="text-lg font-extrabold text-gray-900 mb-2 leading-snug">Your Record Is Clean</h2>
            <p className="text-sm text-gray-500 leading-relaxed mb-5">
              You currently have <span className="font-bold text-emerald-600">0 strikes</span>. An appeal can only be filed when you have at least one active strike on your account.
            </p>
            <div className="w-full flex items-start gap-2.5 rounded-xl p-3.5 text-left border bg-blue-50/70 border-blue-100 mb-5">
              <Info size={15} className="flex-shrink-0 mt-0.5 text-blue-500" />
              <p className="text-xs text-blue-700/90 leading-relaxed">
                Strikes are issued for repeated no-shows or facility misuse. Keep attending your bookings to stay strike-free.
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-[#262367] text-white text-sm font-bold hover:bg-[#35318c] transition"
            >
              Got it
            </button>
          </>
        ) : pendingAppeal ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center mb-4">
              <Clock className="w-9 h-9 text-amber-500" />
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-amber-100 text-amber-700 mb-3">
              Appeal Pending
            </span>
            <h2 className="text-lg font-extrabold text-gray-900 mb-2 leading-snug">Appeal Under Review</h2>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              The administration is reviewing your appeal. You'll be notified by message once a decision is made.
            </p>
            <div className="w-full flex items-center justify-center gap-2 rounded-xl p-3 border bg-gray-50 border-gray-100 mb-4">
              <div className="flex gap-1">
                {[1, 2, 3].map(i => (
                  <span key={i} className={`w-1.5 h-3.5 rounded-full ${i <= strikes ? 'bg-red-400' : 'bg-gray-200'}`} />
                ))}
              </div>
              <span className="text-xs font-bold text-gray-500">{strikes} of 3 strikes</span>
            </div>
            <div className="w-full rounded-xl p-3.5 text-left border bg-gray-50 border-gray-100 mb-5">
              <p className="text-[10px] uppercase tracking-wider font-bold mb-1 text-gray-400">Your Reason</p>
              <p className="text-xs line-clamp-4 italic text-gray-600">"{pendingAppeal.reason}"</p>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-[#262367] text-white text-sm font-bold hover:bg-[#35318c] transition"
            >
              Close
            </button>
          </>
        ) : (
          <>
            <div className="w-16 h-16 rounded-2xl bg-[#262367]/10 flex items-center justify-center mb-4">
              <Scale className="w-9 h-9 text-[#262367]" />
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-red-50 text-red-700 mb-3">
              {strikes} of 3 Strikes
            </span>
            <h2 className="text-lg font-extrabold text-gray-900 mb-2 leading-snug">Appeal Your Strikes</h2>
            <p className="text-sm text-gray-500 leading-relaxed mb-5">
              Submit a formal appeal to have your strikes reviewed by the administration.
            </p>
            <form onSubmit={handleSubmit} className="w-full space-y-3">
              <div className="flex items-start gap-2.5 rounded-xl p-3.5 border text-left bg-amber-50 border-amber-100">
                <Info size={14} className="flex-shrink-0 mt-0.5 text-amber-500" />
                <p className="text-xs text-amber-700 leading-relaxed">
                  You may submit <span className="font-bold">one appeal at a time</span>. If approved, your strikes reset to zero and your account is reactivated.
                </p>
              </div>
              <div className="text-left">
                <label className="block text-xs font-bold uppercase tracking-widest mb-1.5 ml-1 text-gray-400">Reason for Appeal</label>
                <textarea
                  required
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  maxLength={500}
                  placeholder="Explain why your strikes should be removed..."
                  className="w-full rounded-xl border border-gray-200 p-3.5 text-sm bg-gray-50 text-gray-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#262367]/20 focus:border-[#262367] transition h-28 resize-none"
                />
                <p className="text-[10px] text-right mt-0.5 mr-1 text-gray-400">{reason.length}/500</p>
              </div>
              <button
                type="submit"
                disabled={submitting || !reason.trim()}
                className="w-full py-2.5 rounded-xl bg-[#262367] text-white text-sm font-bold hover:bg-[#35318c] transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting ? <><RefreshCw className="animate-spin" size={16} /> Submitting…</> : 'Submit Appeal'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

// ── Contact Administration — floating launcher + popup (bottom-right) ─────────
function MessagesFab({ profile, messages: sharedMessages, onOpen }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [open, setOpen] = useState(false)
  const messages = useMemo(() => (sharedMessages || []).filter(m => m.direction !== 'from_student' && !m.hidden_for_student), [sharedMessages])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState(null)   // { type, text }

  // When the student opens their messages, mark admin messages as read
  // (this read receipt is visible to the admin as "Seen").
  useEffect(() => {
    if (!open) return
    messages.forEach(m => {
      if (!m.read) {
        updateDoc(doc(db, 'admin_messages', m.id), { read: true, read_at: serverTimestamp() }).catch(() => { })
      }
    })
  }, [open, messages])

  async function send(e) {
    e?.preventDefault?.()
    if (!subject.trim() || !body.trim() || sending) return
    setSending(true); setStatus(null)
    try {
      await addDoc(collection(db, 'admin_messages'), {
        direction: 'from_student',
        sender_uid: profile.uid,
        sender_student_id: profile.student_id,
        sender_name: profile.name || 'Student',
        subject: sanitizeText(subject),
        message: sanitizeText(body),
        recipient_id: 'admin',
        created_at: serverTimestamp(),
      })
      setStatus({ type: 'success', text: 'Sent! Administration will reply in your Mail.' })
      setSubject(''); setBody('')
      setTimeout(() => { setStatus(null); setOpen(false) }, 1800)
    } catch {
      setStatus({ type: 'error', text: 'Could not send. Please try again.' })
    }
    setSending(false)
  }

  const count = messages.length

  return (
    <>
      {/* Popup card */}
      {open && (
        <div className={`fixed bottom-24 right-5 z-50 w-[384px] max-w-[calc(100vw-2.5rem)] rounded-3xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in zoom-in-95 duration-200 ${isDark ? 'bg-[#1a1740] ring-1 ring-white/10' : 'bg-white ring-1 ring-[#262367]/10'}`}>
          {/* Header */}
          <div className="relative bg-gradient-to-br from-[#2a2472] to-[#19154f] px-5 pt-5 pb-5 text-white">
            <button onClick={() => setOpen(false)} className="absolute right-4 top-4 w-8 h-8 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition">
              <X size={18} />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-white/10 ring-1 ring-white/15 flex items-center justify-center flex-shrink-0">
                <MessageSquare size={22} className="text-[#F5C900]" />
              </div>
              <div className="min-w-0">
                <h3 className="font-bold text-base leading-tight">Contact Administration</h3>
                <p className="text-white/55 text-xs mt-0.5">Send a message — replies arrive in your Mail</p>
              </div>
            </div>
          </div>

          {/* Compose */}
          <form onSubmit={send} className="p-5 flex flex-col gap-3.5">
            <div>
              <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Subject</label>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="What is this about?"
                maxLength={120}
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-[#262367] focus:ring-2 focus:ring-[#262367]/15 transition"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Message</label>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Write your message to administration…"
                maxLength={1000}
                rows={4}
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-[#262367] focus:ring-2 focus:ring-[#262367]/15 transition resize-none"
              />
              <p className="text-[10px] text-gray-400 text-right mt-1">{body.length}/1000</p>
            </div>

            {status && (
              <div className={`flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-xl ${status.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                {status.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
                {status.text}
              </div>
            )}

            <div className="flex items-center gap-2.5">
              <button type="submit" disabled={sending || !subject.trim() || !body.trim()}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#262367] text-white text-sm font-bold hover:bg-[#1a174d] transition shadow-lg shadow-[#262367]/20 disabled:opacity-50 disabled:cursor-not-allowed">
                {sending ? <RefreshCw size={15} className="animate-spin" /> : <Send size={15} />} Send Message
              </button>
              <button type="button" onClick={() => { setOpen(false); setStatus(null) }}
                className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition">
                Cancel
              </button>
            </div>

            <button type="button" onClick={() => { setOpen(false); onOpen?.() }}
              className="mt-0.5 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#262367] hover:underline">
              <Mail size={13} /> View all messages{count > 0 ? ` (${count})` : ''}
            </button>
          </form>
        </div>
      )}

      {/* Floating action button — Contact Administration */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Contact Administration"
        className={`fixed bottom-5 right-5 z-40 w-14 h-14 rounded-2xl bg-[#F5C900] flex items-center justify-center ring-1 ring-black/5 hover:bg-[#e6bd00] hover:scale-105 active:scale-95 transition-all ${isDark ? 'shadow-lg shadow-black/40' : 'shadow-xl shadow-[#F5C900]/30'}`}
      >
        {open
          ? <X size={22} className="text-[#262367]" />
          : <MessageSquare size={22} className="text-[#262367]" />}
      </button>
    </>
  )
}

// Single door — Collaborative Rooms (small, enclosed)
function SingleDoor({ size = 18, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="2" width="16" height="20" rx="1.5" />
      <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

// Double door — Makers' Spaces (larger, open)
function DoubleDoor({ size = 18, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="2" width="20" height="20" rx="1.5" />
      <line x1="12" y1="2" x2="12" y2="22" />
      <circle cx="9.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

const ROOMS = [
  { id: 'collab-001', name: 'Collaborative Room 1', location: 'Medium Capacity', capacity: 6, capacityLabel: '4 – 6 people', amenities: 'Whiteboard, Power Outlets, WiFi', Icon: SingleDoor },
  { id: 'collab-002', name: 'Collaborative Room 2', location: 'Medium Capacity', capacity: 6, capacityLabel: '4 – 6 people', amenities: 'Whiteboard, Power Outlets, WiFi', Icon: SingleDoor },
  { id: 'makers-001', name: "Innovative Makers' Space 1", location: 'Large Capacity', capacity: 8, capacityLabel: '6 – 8 people', amenities: 'Whiteboard, Power Outlets, WiFi, Equipment', Icon: DoubleDoor },
  { id: 'makers-002', name: "Innovative Makers' Space 2", location: 'Large Capacity', capacity: 8, capacityLabel: '6 – 8 people', amenities: 'Whiteboard, Power Outlets, WiFi, Equipment', Icon: DoubleDoor },
]

const TIME_SLOTS = [
  '8:00 AM – 10:00 AM',
  '10:00 AM – 12:00 PM',
  '12:00 PM – 2:00 PM',
  '2:00 PM – 4:00 PM',
]

const STATUS_STYLES = {
  Confirmed: 'bg-blue-50 text-blue-700 border border-blue-200',
  'Checked-In': 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  Active: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  Done: 'bg-emerald-100 text-emerald-800 border border-emerald-300',
  Cancelled: 'bg-gray-100 text-gray-500 border border-gray-200',
  'No-Show': 'bg-orange-50 text-orange-700 border border-orange-200',
  Pending: 'bg-amber-50 text-amber-700 border border-amber-200',
}

export default function Dashboard() {
  return <ThemeProvider><DashboardInner /></ThemeProvider>
}

const PAGE_BG = {
  light: '#F0F4FF',
  dark: '#0d0c1a',
}

function DashboardInner() {
  const { theme } = useTheme()
  const navigate = useNavigate()
  const [view, setView] = useState('overview')
  const [profile, setProfile] = useState(null)
  const [bookings, setBookings] = useState([])
  const [allBookings, setAllBookings] = useState([])
  const [announcements, setAnnouncements] = useState([])
  const [loading, setLoading] = useState(true)
  const [alertMsg, setAlertMsg] = useState(null)
  const [confirmModal, setConfirmModal] = useState(null)
  const [dismissedNotifs, setDismissedNotifs] = useState([])
  const [now, setNow] = useState(Date.now()) // ticking clock for countdown
  const [cyberspaceModal, setCyberspaceModal] = useState(null) // { state, booking }
  const [receiptModal, setReceiptModal] = useState(null) // booking object

  const [submitting, setSubmitting] = useState(false)
  const [bookingMsg, setBookingMsg] = useState(null) // { type: 'success' | 'error', text }
  const [pendingAppeal, setPendingAppeal] = useState(null)
  const [appealModal, setAppealModal] = useState(false)
  const [adminMessages, setAdminMessages] = useState([])
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    const localFallback = JSON.parse(localStorage.getItem('lcspace_announcements') || '[]')

    const q = query(collection(db, 'announcements'), orderBy('created_at', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setAnnouncements(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }, err => {
      console.warn('Firestore announcements failed, using localStorage:', err.message)
      setAnnouncements(localFallback)

      const handleStorage = (e) => {
        if (e.key === 'lcspace_announcements') setAnnouncements(JSON.parse(e.newValue || '[]'))
      }
      window.addEventListener('storage', handleStorage)
      return () => window.removeEventListener('storage', handleStorage)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const snap = await getDoc(doc(db, 'users', user.uid))
        setProfile(snap.exists()
          ? { uid: user.uid, ...snap.data() }
          : { uid: user.uid, name: user.email, email: user.email, student_id: user.uid, role: 'student', status: 'ACTIVE', strike_count: 0 })
      } else {
        const dev = JSON.parse(sessionStorage.getItem('dev_user') || 'null')
        if (!dev) { navigate('/'); return }
        setProfile(dev)
      }
      setLoading(false)
    })
    return unsub
  }, [navigate])

  // Ticking clock — updates every 5s for countdown accuracy
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!profile?.uid) return
    if (sessionStorage.getItem('dev_user')) {
      const allB = JSON.parse(localStorage.getItem('lcspace_bookings_v1') || '[]')
      setBookings(allB.filter(b => b.student_id === profile.student_id || b.user_id === profile.uid))
      setAllBookings(allB)
      return
    }

    const qAll = query(collection(db, 'bookings'))
    const unsubAll = onSnapshot(qAll, snap => {
      setAllBookings(snap.docs.map(d => ({ ...d.data(), docId: d.id })))
    }, err => {
      console.warn('Firestore real-time fetch of all bookings failed:', err.message)
    })

    // Query by user_id (Firebase UID) — always consistent regardless of student_id format
    const q = query(collection(db, 'bookings'), where('user_id', '==', profile.uid))
    const unsub = onSnapshot(q, snap => {
      setBookings(
        snap.docs
          .map(d => ({ ...d.data(), docId: d.id }))
          .filter(b => !b.hidden_for_student)
          .sort((a, b) => new Date(b.created_at?.seconds * 1000 || b.created_at) - new Date(a.created_at?.seconds * 1000 || a.created_at))
      )
    }, err => {
      console.warn('Firestore real-time fetch failed:', err.message)
    })
    const qAppeals = query(collection(db, 'appeals'), where('user_id', '==', profile.uid), where('status', '==', 'pending'))
    const unsubAppeals = onSnapshot(qAppeals, snap => {
      setPendingAppeal(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() })
    }, err => console.warn('Appeals fetch failed:', err.message))

    // Admin Messages Sync (Direct & Broadcast)
    let msgs1 = [], msgs2 = []
    const syncMsgs = () => {
      const all = [...msgs1, ...msgs2]
      const unique = Array.from(new Map(all.map(m => [m.id, m])).values())
      unique.sort((a, b) => {
        const ta = a.created_at?.seconds ? a.created_at.seconds * 1000 : new Date(a.created_at || 0).getTime()
        const tb = b.created_at?.seconds ? b.created_at.seconds * 1000 : new Date(b.created_at || 0).getTime()
        return tb - ta
      })
      setAdminMessages(unique)
    }

    const mq1 = query(collection(db, 'admin_messages'), where('recipient_uid', '==', profile.uid))
    const munsub1 = onSnapshot(mq1, snap => {
      msgs1 = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      syncMsgs()
    }, err => console.warn('Admin messages sync error:', err.message))

    const mq2 = query(collection(db, 'admin_messages'), where('recipient_id', '==', 'all'))
    const munsub2 = onSnapshot(mq2, snap => {
      msgs2 = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      syncMsgs()
    }, err => console.warn('Broadcast sync error:', err.message))

    return () => {
      unsubAll()
      unsub()
      unsubAppeals()
      munsub1()
      munsub2()
    }
  }, [profile])


  const notifications = useMemo(() => {
    const list = []
    const today = localISO(new Date())
    const in3 = new Date(); in3.setDate(in3.getDate() + 3)

    bookings
      .filter(b => b.booking_date === today && b.status !== 'Cancelled')
      .forEach(b => list.push({ id: `t-${b.id}`, type: 'reminder', title: 'Booking Today', message: `${b.room_name} at ${b.time}`, time: 'Today' }))

    bookings
      .filter(b => {
        if (!b.booking_date || b.booking_date === today || b.status === 'Cancelled') return false
        const d = new Date(b.booking_date + 'T00:00')
        return d > new Date() && d <= in3
      })
      .forEach(b => list.push({ id: `u-${b.id}`, type: 'info', title: 'Upcoming Booking', message: `${b.room_name} — ${b.date}`, time: b.date }))

    announcements.forEach(a => {
      list.push({ id: `a-${a.id}`, type: 'alert', title: a.title, message: a.content, time: a.created_at ? new Date(a.created_at.seconds * 1000).toLocaleDateString() : 'New' })
    })

    adminMessages.forEach(m => {
      if (m.direction === 'from_student' || m.hidden_for_student || m.read) return
      list.push({
        id: `m-${m.id}`,
        type: 'info',
        title: m.recipient_id === 'all' ? 'Broadcast' : 'Message from Admin',
        message: m.subject || m.message,
        time: m.created_at ? new Date(m.created_at.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'New'
      })
    })

    return list.filter(n => !dismissedNotifs.includes(n.id))
  }, [bookings, announcements, adminMessages, dismissedNotifs])

  const handleDismissNotification = (id) => {
    setDismissedNotifs(prev => [...prev, id])
  }

  const handleDeleteBooking = (bookingId) => {
    setConfirmModal({
      title: 'Remove from My Reservations',
      message: 'This will remove the reservation from your list. The record will still be retained by the admin.',
      onConfirm: async () => {
        try {
          if (sessionStorage.getItem('dev_user')) {
            const prev = JSON.parse(localStorage.getItem('lcspace_bookings_v1') || '[]')
            const updated = prev.map(b => b.id === bookingId ? { ...b, hidden_for_student: true } : b)
            localStorage.setItem('lcspace_bookings_v1', JSON.stringify(updated))
            setBookings(updated.filter(b => !b.hidden_for_student))
            window.dispatchEvent(new CustomEvent('lcspace_data_updated', { detail: updated }))
          } else {
            await updateDoc(doc(db, 'bookings', bookingId), {
              hidden_for_student: true,
              hidden_for_student_at: serverTimestamp(),
            })
          }
        } catch (err) {
          setAlertMsg('Unable to remove reservation. Please try again.')
        }
      }
    })
  }

  // ── Cancellation — only available for Confirmed bookings ──────────────────────
  const handleCancelBooking = useCallback((booking) => {
    setConfirmModal({
      title: 'Cancel Reservation',
      message: `Are you sure you want to cancel booking ${booking.id}? This cannot be undone and the room will be freed up.`,
      danger: true,
      onConfirm: async () => {
        try {
          if (sessionStorage.getItem('dev_user')) {
            const prevB = JSON.parse(localStorage.getItem('lcspace_bookings_v1') || '[]')
            const updatedB = prevB.map(b => b.id === booking.id ? { ...b, status: 'Cancelled', cancelled_at: new Date().toISOString() } : b)
            localStorage.setItem('lcspace_bookings_v1', JSON.stringify(updatedB))
            setAllBookings(updatedB)
            setBookings(updatedB.filter(b => b.student_id === profile.student_id))
          } else {
            await updateDoc(doc(db, 'bookings', booking.docId), {
              status: 'Cancelled',
              cancelled_at: serverTimestamp(),
            })
            try { await deleteDoc(doc(db, 'cyberspace_tokens', booking.docId)) } catch { }
          }
        } catch (err) {
          setAlertMsg('Unable to cancel reservation. Please try again.')
        }
      }
    })
  }, [now, profile])


  async function handleSignOut() {
    setLoggingOut(true)
    await new Promise(r => setTimeout(r, 1200))
    try { await signOut(auth) } catch (_) { }
    sessionStorage.removeItem('dev_user')
    navigate('/')
  }

  async function handleBooking(e, { selectedDate, selectedRoom, selectedTime, purpose, groupSize } = {}) {
    if (e && e.preventDefault) e.preventDefault()
    setBookingMsg(null)

    // ── Rate limiting ─────────────────────────────────────────
    const rl = checkRateLimit('booking')
    if (!rl.allowed) {
      setBookingMsg({ type: 'error', text: `Too many booking attempts. Please wait ${formatRetryAfter(rl.retryAfterMs)}.` })
      return
    }

    // ── Validate date (no past dates) ──────────────────────────
    const today = localISO(new Date())
    if (selectedDate < today) {
      setBookingMsg({ type: 'error', text: 'You cannot book a room for a past date.' })
      return
    }

    // ── Validate time (slot must not have fully ended yet) ──
    if (selectedDate === today && selectedTime) {
      // Use the END part of the slot (e.g. '12:00 PM' from '10:00 AM – 12:00 PM')
      const sep = selectedTime.includes('\u2013') ? '\u2013' : '-'
      const endPart = (selectedTime.split(sep)[1] || '').trim()
      const m = endPart.match(/(\d+):(\d+)\s*(AM|PM)/i)
      if (m) {
        let h = parseInt(m[1], 10); const mm = parseInt(m[2], 10)
        const period = m[3].toUpperCase()
        if (period === 'PM' && h !== 12) h += 12
        if (period === 'AM' && h === 12) h = 0
        // Use manual parsing for consistency and to avoid timezone issues
        const [y, mon, dd] = selectedDate.split('-').map(Number)
        const slotEnd = new Date(y, mon - 1, dd)
        slotEnd.setHours(h, mm, 0, 0)

        if (slotEnd.getTime() <= Date.now()) {
          setBookingMsg({ type: 'error', text: 'This time slot has already ended. Please choose a later slot or a future date.' })
          return
        }
      }
    }

    // ── Sanitize purpose field ──────────────────────────────
    const cleanPurpose = sanitizeText(purpose)
    if (!cleanPurpose || cleanPurpose.length < 5) {
      setBookingMsg({ type: 'error', text: 'Please describe the purpose of your reservation (min 5 characters).' })
      return
    }

    // ── One ACTIVE reservation per student per day (client-side fast check) ───
    // Completed (Done), missed (No-Show) and Cancelled bookings should NOT block
    // a new reservation — only a still-active one does.
    const ACTIVE_DAY_STATUSES = ['Pending', 'Confirmed', 'Checked-In', 'Active']
    const alreadyBookedToday = (bookings || []).some(b =>
      b.booking_date === selectedDate &&
      ACTIVE_DAY_STATUSES.includes(b.status)
    )
    if (alreadyBookedToday) {
      setBookingMsg({ type: 'error', text: 'You already have a reservation on this date. Only one reservation is allowed per day.' })
      return
    }

    // ── Prevent double booking (client-side fast check) ───────
    // Slot is "taken" only while booking is active. Done/Cancelled/No-Show free the spot.
    const SLOT_TAKEN_STATUSES = ['Pending', 'Confirmed', 'Checked-In', 'Active']
    const isDoubleBooked = allBookings.some(b =>
      b.room_id === selectedRoom &&
      b.booking_date === selectedDate &&
      b.time === selectedTime &&
      SLOT_TAKEN_STATUSES.includes(b.status)
    )
    if (isDoubleBooked) {
      setBookingMsg({ type: 'error', text: 'This time slot has already been reserved. Please choose a different time or room.' })
      return
    }

    setSubmitting(true)

    // ── Server-side: one-per-day check ─────────────────────────
    if (!sessionStorage.getItem('dev_user')) {
      const studentKey = profile?.student_id || profile?.uid
      if (studentKey) {
        const dayDupSnap = await getDocs(query(
          collection(db, 'bookings'),
          where('student_id', '==', studentKey),
          where('booking_date', '==', selectedDate)
        ))
        const hasDayDup = dayDupSnap.docs.some(d => ['Pending', 'Confirmed', 'Checked-In', 'Active'].includes(d.data().status))
        if (hasDayDup) {
          setBookingMsg({ type: 'error', text: 'You already have a reservation on this date. Only one reservation is allowed per day.' })
          setSubmitting(false)
          return
        }
      }
    }

    // ── Server-side conflict check before writing ──────────────
    if (!sessionStorage.getItem('dev_user')) {
      const conflictSnap = await getDocs(query(
        collection(db, 'bookings'),
        where('room_id', '==', selectedRoom),
        where('booking_date', '==', selectedDate),
        where('time', '==', selectedTime)
      ))
      const ACTIVE_STATUSES = ['Pending', 'Confirmed', 'Checked-In', 'Active']
      const hasConflict = conflictSnap.docs.some(d => ACTIVE_STATUSES.includes(d.data().status))
      if (hasConflict) {
        setBookingMsg({ type: 'error', text: 'This time slot was just taken. Please choose a different time or room.' })
        setSubmitting(false)
        return
      }
    }

    const room = ROOMS.find(r => r.id === selectedRoom)
    const bookingId = Math.random().toString(36).slice(2, 8).toUpperCase()
    const booking = {
      id: bookingId,
      user_id: profile?.uid || '',
      student_id: profile?.student_id || profile?.uid || 'unknown_id',
      student_name: profile?.name || 'Unknown Student',
      name: profile?.name || 'Unknown Student',
      room_id: selectedRoom || '',
      room_name: room?.name || '',
      facility: room?.name || '',
      booking_date: selectedDate,
      date: new Date(selectedDate + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: selectedTime,
      purpose: cleanPurpose,
      group_size: Math.min(Math.max(parseInt(groupSize) || 1, 1), 8),
      status: 'Pending',
      created_at: new Date().toISOString(),
    }

    try {
      if (sessionStorage.getItem('dev_user')) {
        const prev = JSON.parse(localStorage.getItem('lcspace_bookings_v1') || '[]')
        const updated = [booking, ...prev]
        localStorage.setItem('lcspace_bookings_v1', JSON.stringify(updated))
        setBookings(updated.filter(b => b.student_id === profile.student_id))
        setAllBookings(updated)
        window.dispatchEvent(new CustomEvent('lcspace_data_updated', { detail: updated }))
      } else {
        await setDoc(doc(db, 'bookings', bookingId), { ...booking, created_at: serverTimestamp() })
        setBookings(prev => [booking, ...prev])
      }
    } catch (err) {
      console.error('Reservation write failed:', err?.code || '', err?.message || err)
      setBookingMsg({ type: 'error', text: `Failed to submit reservation${err?.code ? ` (${err.code})` : ''}. Please try again.` })
      setSubmitting(false)
      return
    }

    setBookingMsg({ type: 'success', text: `Reservation submitted! Waiting for admin confirmation. ID: ${bookingId}` })
    setSubmitting(false)
    setTimeout(() => { setView('bookings'); setBookingMsg(null) }, 3000)
  }

  if (loading) return <LoadingScreen type="student" page={view} />

  const today = localISO(new Date())
  const shortToday = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const todayBooking = bookings.find(b =>
    (b.booking_date === today || b.date?.includes(shortToday)) &&
    ['Pending', 'Confirmed', 'Checked-In', 'Active'].includes(b.status)
  )
  const displayName = profile?.preferred_name || profile?.name || 'Student'
  const firstName = displayName.split(' ')[0]

  const PAGE_TITLES = { overview: `Welcome, ${firstName}`, reserve: 'Reserve a Facility', bookings: 'My Reservations', mail: 'Admin Mailbox', help: 'Help & Support', settings: 'Account Settings' }

  return (
    <div data-theme={theme} className="flex h-screen overflow-hidden" style={{ background: PAGE_BG[theme] }}>
      {loggingOut && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3" style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}>
          <div className="w-8 h-8 border-[3px] border-white/20 border-t-white rounded-full animate-spin" />
          <p className="text-white text-sm font-semibold tracking-wide">Signing out…</p>
        </div>
      )}
      <Sidebar
        view={view} setView={setView}
        displayName={displayName} profile={profile}
        todayBooking={todayBooking} bookings={bookings}
        onSignOut={handleSignOut} navigate={navigate}
        setAlertMsg={setAlertMsg}
        setCyberspaceModal={setCyberspaceModal}
        setAppealModal={setAppealModal}
        pendingAppeal={pendingAppeal}
      />
      <div className="ml-64 flex-1 flex flex-col overflow-hidden">
        <TopBar title={PAGE_TITLES[view]} notifications={notifications} profile={profile} onDismissNotification={handleDismissNotification} />
        <main className="flex-1 overflow-auto">
          {view === 'overview' && (
            <Overview firstName={firstName} profile={profile} bookings={bookings} todayBooking={todayBooking} setView={setView} today={today} announcements={announcements} allBookings={allBookings} />
          )}
          {view === 'reserve' && (
            <Reserve
              rooms={ROOMS} timeSlots={TIME_SLOTS}
              onSubmit={handleBooking} message={bookingMsg} submitting={submitting}
              allBookings={allBookings}
              profile={profile}
            />
          )}
          {view === 'bookings' && (
            <Reservations
              bookings={bookings}
              setView={setView}
              statusStyles={STATUS_STYLES}
              onDelete={handleDeleteBooking}
              onCancel={handleCancelBooking}
              now={now}
              onReceipt={setReceiptModal}
            />
          )}
          {view === 'calendar' && (
            <BookingCalendar bookings={bookings} setView={setView} />
          )}
          {view === 'mail' && (
            <StudentMail profile={profile} />
          )}
          {view === 'help' && (
            <StudentHelp profile={profile} />
          )}
          {view === 'guide' && (
            <GuideAndRules />
          )}
          {view === 'settings' && (
            <AccountSettings profile={profile} setProfile={setProfile} />
          )}
        </main>
      </div>

      {/* Custom Alert Overlay */}
      {alertMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl relative animate-in zoom-in-95 duration-200 border border-[#262367]/10">
            <div className="w-16 h-16 rounded-full bg-[#262367]/5 flex items-center justify-center mx-auto mb-5">
              <AlertTriangle className="w-8 h-8 text-[#262367]" />
            </div>
            <h3 className="text-xl font-bold text-center text-[#262367] mb-2">Notice</h3>
            <p className="text-center text-gray-500 text-sm mb-8 leading-relaxed">
              {alertMsg}
            </p>
            <button onClick={() => setAlertMsg(null)}
              className="w-full bg-[#262367] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#35318c] transition shadow-lg shadow-[#262367]/20">
              Understood
            </button>
          </div>
        </div>
      )}

      {/* Receipt Preview Modal */}
      {receiptModal && (
        <ReceiptModal booking={receiptModal} onClose={() => setReceiptModal(null)} />
      )}

      {/* Cyberspace Access Modal */}
      {cyberspaceModal && (
        <CyberspaceAccessModal
          state={cyberspaceModal.state}
          booking={cyberspaceModal.booking}
          hasPendingBooking={cyberspaceModal.hasPendingBooking}
          onClose={() => setCyberspaceModal(null)}
          onPasswordSuccess={() => { setCyberspaceModal(null); navigate('/session') }}
        />
      )}

      <AppealStrikesModal
        profile={profile}
        isOpen={appealModal}
        onClose={() => setAppealModal(false)}
        pendingAppeal={pendingAppeal}
      />

      {/* Floating Messages launcher — hidden while already in Mail */}
      {view !== 'mail' && <MessagesFab profile={profile} messages={adminMessages} onOpen={() => setView('mail')} />}

      {/* Confirm Modal Overlay */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl relative animate-in zoom-in-95 duration-200 border border-[#262367]/10">
            <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5 ${confirmModal.danger ? 'bg-red-50' : 'bg-amber-50'}`}>
              <AlertTriangle className={`w-8 h-8 ${confirmModal.danger ? 'text-red-500' : 'text-amber-500'}`} />
            </div>
            <h3 className="text-xl font-bold text-center text-[#262367] mb-2">{confirmModal.title}</h3>
            <p className="text-center text-gray-500 text-sm mb-8 leading-relaxed">
              {confirmModal.message}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmModal(null)}
                className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-bold text-sm hover:bg-gray-200 transition">
                No, Keep It
              </button>
              <button onClick={() => { confirmModal.onConfirm(); setConfirmModal(null) }}
                className={`flex-1 text-white py-3 rounded-xl font-bold text-sm transition shadow-lg ${confirmModal.danger
                  ? 'bg-red-600 hover:bg-red-700 shadow-red-600/20'
                  : 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20'
                  }`}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────────────────────────

function TopBar({ title, notifications, profile, onDismissNotification }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <header className={`lc-topbar h-[60px] backdrop-blur-xl px-8 flex items-center justify-between flex-shrink-0 sticky top-0 z-20 border-b ${
      isDark ? 'bg-[#0d0c1a]/80 border-white/10' : 'bg-white/80 border-gray-200'
    }`}>
      <div>
        <h1 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{title}</h1>
        <p className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>{dateStr}</p>
      </div>
      <div className="flex items-center gap-3">
        <NotificationBell notifications={notifications} onDismiss={onDismissNotification} />
      </div>
    </header>
  )
}

// ─────────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────────

function SidebarProfileCard({ profile, onSignOut, setView }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const fullName = profile?.preferred_name || profile?.name || 'Student'
  const firstName = fullName.split(' ')[0]
  const dept = profile?.department || ''
  const sid = profile?.student_id || ''
  const avatar = profile?.photo_url ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.name || 'S')}&background=152243&color=F5C900&size=64&rounded=true`
  const isActive = (profile?.status ?? 'ACTIVE') === 'ACTIVE'

  return (
    <div ref={ref} className="px-3 py-2 border-t border-white/10 flex-shrink-0 relative">

      {/* Popup — logout only */}
      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-2 bg-white rounded-2xl shadow-2xl overflow-hidden z-50 border border-gray-100">
          <button
            onClick={() => { setOpen(false); onSignOut() }}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-red-600 hover:bg-red-50 transition-colors font-medium">
            <LogOut size={14} />
            Log Out
          </button>
        </div>
      )}

      {/* Profile card trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/[0.07] transition-colors text-left">
        <div className="relative flex-shrink-0">
          <img src={avatar} alt={firstName} className="w-7 h-7 rounded-full object-cover border border-white/20" />
          <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-[#262367] ${isActive ? 'bg-emerald-400' : 'bg-red-400'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white leading-tight truncate">{firstName}</p>
          {sid && <p className="text-[10px] text-white/40 leading-none truncate">{sid}</p>}
          {dept && <p className="text-[10px] text-[#F5C900]/70 leading-none truncate">{dept}</p>}
        </div>
        <ChevronUp size={12} className={`text-white/30 flex-shrink-0 transition-transform ${open ? 'rotate-0' : 'rotate-180'}`} />
      </button>
    </div>
  )
}

function Sidebar({ view, setView, displayName, profile, todayBooking, bookings, onSignOut, navigate, setAlertMsg, setCyberspaceModal, setAppealModal, pendingAppeal }) {
  const NAV = [
    { key: 'overview', Icon: LayoutDashboard, label: 'Overview' },
    { key: 'reserve', Icon: Calendar, label: 'Reserve Facility' },
    { key: 'bookings', Icon: ClipboardList, label: 'My Reservations' },
    { key: 'calendar', Icon: CalendarDays, label: 'My Calendar' },
    { key: 'mail', Icon: Mail, label: 'Mail' },
    { key: 'help', Icon: HelpCircle, label: 'Help & Support' },
    { key: 'guide', Icon: BookOpen, label: 'Guide & Rules' },
    { key: 'settings', Icon: Settings, label: 'Account Settings' },
  ]

  const missingRecovery = !profile?.recovery_email || !profile?.recovery_question || !profile?.recovery_answer;

  // Unseen-mail indicator: count unread direct messages → shows a yellow dot on
  // the Mail nav item, which clears once the student opens Mail (messages read).
  const [unreadMail, setUnreadMail] = useState(0)
  useEffect(() => {
    if (!profile?.uid) return
    const q = query(collection(db, 'admin_messages'), where('recipient_uid', '==', profile.uid))
    const unsub = onSnapshot(q, snap => {
      const n = snap.docs
        .map(d => d.data())
        .filter(m => m.direction !== 'from_student' && !m.hidden_for_student && !m.read).length
      setUnreadMail(n)
    }, () => { })
    return unsub
  }, [profile?.uid])
  const unseen = { mail: unreadMail > 0 }


  const canAccessCyberspace = CYBERSPACE_TEST_MODE || ['Checked-In', 'Active'].includes(todayBooking?.status)

  function handleCyberspace() {
    // TEMP testing bypass — open the session directly, skip all access gates.
    if (CYBERSPACE_TEST_MODE) { navigate('/session'); return }
    // No booking today at all
    if (!todayBooking) {
      const hasPendingBooking = (bookings || []).some(b => b.status !== 'Cancelled')
      setCyberspaceModal({ state: 'no_booking', booking: null, hasPendingBooking })
      return
    }
    // Session is already done/cancelled — no access code should be shown
    if (['Done', 'Cancelled', 'No-Show'].includes(todayBooking.status)) {
      setCyberspaceModal({ state: 'expired', booking: todayBooking })
      return
    }
    // Booking exists but not yet confirmed by admin
    if (!['Confirmed', 'Checked-In', 'Active'].includes(todayBooking.status)) {
      setCyberspaceModal({ state: 'not_confirmed', booking: todayBooking })
      return
    }
    // Confirmed but not yet checked in at admin desk
    if (todayBooking.status === 'Confirmed') {
      setCyberspaceModal({ state: 'not_checked_in', booking: todayBooking })
      return
    }
    // Parse the reserved time window
    const slot = parseTimeSlot(todayBooking.time, todayBooking.booking_date)
    if (slot) {
      const nowMs = Date.now()
      if (nowMs < slot.startMs) {
        // Too early — session hasn't started yet
        setCyberspaceModal({ state: 'too_early', booking: todayBooking })
        return
      }
      if (nowMs > slot.endMs) {
        // Session window has passed
        setCyberspaceModal({ state: 'expired', booking: todayBooking })
        return
      }
    }
    // All checks passed — prompt for access code
    setCyberspaceModal({ state: 'needs_password', booking: todayBooking })
  }

  return (
    <aside className="lc-sidebar w-64 bg-[#262367] flex flex-col fixed inset-y-0 left-0 z-30 border-r border-white/10">

      {/* Brand */}
      <div className="h-[60px] flex items-center gap-3 px-5 border-b border-white/10 flex-shrink-0">
        <img
          src="/assets/img/Schoollogo.png" alt="USPF"
          className="w-8 h-8 object-contain flex-shrink-0"
          onError={e => { e.target.style.display = 'none' }}
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white leading-tight">LCspace</p>
          <p className="text-[10px] text-[#F5C900] leading-tight mt-0.5">Student Portal</p>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-3 py-3 overflow-y-auto">
        <div className="space-y-0.5">
          {NAV.map(({ key, Icon, label }) => (
            <button key={key} onClick={() => setView(key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left relative ${view === key
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
                }`}>
              <Icon size={15} className={`flex-shrink-0 ${view === key ? 'text-[#F5C900]' : ''}`} />
              <span className="flex-1">{label}</span>
              {key === 'settings' && missingRecovery && (
                <span className="w-2 h-2 rounded-full bg-red-500 absolute right-3 shadow-[0_0_8px_rgba(239,68,68,0.6)]"></span>
              )}
              {unseen[key] && view !== key && (
                <span className="w-2 h-2 rounded-full bg-[#F5C900] absolute right-3 shadow-[0_0_8px_rgba(245,201,0,0.7)] animate-pulse"></span>
              )}
            </button>
          ))}
        </div>

        {/* Resources */}
        <div className="mt-5 pt-4 border-t border-white/10 space-y-0.5">
          <p className="px-3 mb-1.5 text-[10px] font-medium text-white/25 uppercase tracking-wider">Resources</p>
          <button onClick={handleCyberspace}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/50 hover:text-white/80 hover:bg-white/[0.05] transition-colors">
            <Monitor size={15} className="flex-shrink-0" />
            <span className="flex-1 text-left">Cyberspace</span>
            {!canAccessCyberspace && <Lock size={11} className="text-white/20 flex-shrink-0" />}
          </button>
          <button onClick={() => setCyberspaceModal({ state: 'library_unavailable', booking: null })}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/50 hover:text-white/80 hover:bg-white/[0.05] transition-colors">
            <BookOpen size={15} className="flex-shrink-0" />
            <span className="flex-1 text-left">Library Catalog</span>
            <Lock size={11} className="text-white/20 flex-shrink-0" />
          </button>
        </div>
      </nav>

      {/* Strike Count strip */}
      {(() => {
        const strikes = profile?.strike_count ?? 0
        const warn = strikes >= 2
        return (
          <div className="px-3 pb-2 flex-shrink-0">
            <div className={`flex items-center justify-between px-3 py-2 rounded-lg border ${warn ? 'bg-red-500/10 border-red-500/20' : 'bg-white/[0.04] border-white/[0.07]'}`}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={12} className={warn ? 'text-red-400' : strikes === 1 ? 'text-amber-400' : 'text-white/25'} />
                <span className="text-[11px] text-white/40 font-medium">Strike Count</span>
              </div>
              <span className={`text-xs font-bold ${warn ? 'text-red-400' : 'text-white/60'}`}>
                {strikes}<span className="text-white/25 font-normal">/3</span>
              </span>
            </div>
            <button
              onClick={() => setAppealModal(true)}
              className={`mt-1.5 w-full py-1.5 rounded-lg border text-[10px] font-bold transition-all flex items-center justify-center gap-1.5 group ${strikes === 0
                ? 'border-white/10 bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/60'
                : 'border-[#F5C900]/30 bg-[#F5C900]/10 text-[#F5C900] hover:bg-[#F5C900]/20'
                }`}
            >
              {pendingAppeal ? (
                <><Timer size={11} className="animate-pulse" /> Appeal Pending</>
              ) : (
                <><MessageSquare size={11} /> Appeal Strikes</>
              )}
            </button>
          </div>
        )
      })()}

      <SidebarProfileCard profile={profile} onSignOut={onSignOut} setView={setView} />

    </aside>
  )
}

// ─────────────────────────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────────────────────────

function Overview({ firstName, profile, bookings, todayBooking, setView, today, announcements, allBookings }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const confirmedCount = bookings.filter(b => ['Confirmed', 'Checked-In', 'Active'].includes(b.status)).length
  const strikes = profile?.strike_count ?? 0
  const status = profile?.status ?? 'ACTIVE'
  const [announcementIdx, setAnnouncementIdx] = useState(0)

  useEffect(() => {
    if (!announcements || announcements.length <= 1) return
    const timer = setInterval(() => {
      setAnnouncementIdx(prev => (prev + 1) % announcements.length)
    }, 5000)
    return () => clearInterval(timer)
  }, [announcements])

  const in3 = new Date(); in3.setDate(in3.getDate() + 3)
  const upcoming = bookings.filter(b => {
    if (!b.booking_date || b.booking_date === today || b.status === 'Cancelled') return false
    const d = new Date(b.booking_date + 'T00:00')
    return d > new Date() && d <= in3
  })

  const missingRecovery = !profile?.recovery_email || !profile?.recovery_question || !profile?.recovery_answer;

  return (
    <div className="p-8 max-w-5xl mx-auto">

      {/* ── Building hero ── */}
      <div className="relative rounded-3xl overflow-hidden mb-6 shadow-2xl" style={{ height: '230px' }}>
        {/* Full building image centered to show sky + building + grass */}
        <img
          src="/assets/img/20230127_JUECO_BUILDING-1.jpg"
          alt="USPF LC Building"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition: 'center 50%' }}
        />
        {/* Dark overlay: strong on the left, fades out by 55% */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(26,23,84,0.96) 0%, rgba(26,23,84,0.88) 35%, rgba(26,23,84,0.45) 55%, transparent 75%)' }} />
        {/* Subtle bottom vignette for grounding */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-center h-full px-9">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded-lg bg-[#F5C900]/20 flex items-center justify-center">
              <BookOpen size={12} className="text-[#F5C900]" />
            </div>
            <span className="text-[10px] font-bold text-[#F5C900] uppercase tracking-[0.2em]">LCspace</span>
          </div>
          <h2 className="text-white font-extrabold text-2xl leading-tight mb-1.5">Learning Commons Space</h2>
          <p className="text-white/65 text-xs leading-relaxed mb-3 max-w-[260px] line-clamp-3">
            LCspace is the University of Southern Philippines Foundation's collaborative learning hub — a purpose-built facility designed to support group study, creative projects, and digital collaboration through modern spaces and Cyberspace technology.
          </p>
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-[11px] text-white/60"><MapPin size={10} className="text-[#F5C900] flex-shrink-0" /> USPF Main Campus, LC Building</span>
            <span className="flex items-center gap-2 text-[11px] text-white/60"><Clock size={10} className="text-[#F5C900] flex-shrink-0" /> Mon – Fri · 8:00 AM – 4:00 PM</span>
            <span className="flex items-center gap-2 text-[11px] text-white/60"><Wifi size={10} className="text-[#F5C900] flex-shrink-0" /> High-speed WiFi included</span>
          </div>
        </div>
      </div>

      {/* ── Announcements + Today's Booking ── unified dark card */}
      <div className="bg-[#262367] rounded-2xl mb-6 relative overflow-hidden shadow-lg">
        <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full translate-x-16 -translate-y-16 pointer-events-none" />
        <div className="absolute bottom-0 left-1/2 w-32 h-32 bg-white/[0.03] rounded-full -translate-x-8 translate-y-10 pointer-events-none" />

        <div className="relative z-10 flex items-center">

          {/* Left — Announcement */}
          <div className="flex-1 flex items-center gap-4 px-6 py-5 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
              <Megaphone size={17} className={announcements?.length > 0 ? 'text-[#F5C900]' : 'text-white/30'} />
            </div>
            <div className="min-w-0 animate-in fade-in duration-500" key={announcementIdx}>
              <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-0.5">Announcement</p>
              <p className="text-white font-bold text-sm leading-snug truncate">
                {announcements?.length > 0 ? announcements[announcementIdx]?.title : 'No new announcements'}
              </p>
              <p className={`text-xs mt-0.5 truncate ${announcements?.length > 0 ? 'text-white/60' : 'text-white/35'}`}>
                {announcements?.length > 0 ? announcements[announcementIdx]?.content : 'You are all caught up!'}
              </p>
              {announcements?.length > 1 && (
                <div className="flex gap-1.5 mt-2">
                  {announcements.map((_, i) => (
                    <div key={i} className={`h-1 rounded-full transition-all duration-300 ${i === announcementIdx ? 'w-4 bg-[#F5C900]' : 'w-1.5 bg-white/20'}`} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Short center divider */}
          <div className="w-px h-8 bg-white/15 flex-shrink-0 rounded-full" />

          {/* Right — Booking status */}
          <div className="flex-1 flex items-center gap-4 px-6 py-5 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
              <Calendar size={17} className={todayBooking ? 'text-[#F5C900]' : 'text-white/30'} />
            </div>
            <div className="flex-1 min-w-0">
              {todayBooking ? (
                <>
                  <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-0.5">Today's Booking</p>
                  <p className="text-white font-bold text-sm leading-snug truncate">{todayBooking.room_name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${todayBooking.status === 'Checked-In' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-white/70'}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />{todayBooking.status}
                    </span>
                    <span className="text-white/40 text-[11px]">{todayBooking.time}</span>
                  </div>
                </>
              ) : upcoming.length > 0 ? (
                <>
                  <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-0.5">Next Reservation</p>
                  <p className="text-white font-bold text-sm leading-snug truncate">{upcoming[0].room_name}</p>
                  <p className="text-white/50 text-xs mt-0.5 truncate">{upcoming[0].date} · {upcoming[0].time}</p>
                </>
              ) : (
                <>
                  <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-0.5">Reservations</p>
                  <p className="text-white font-bold text-sm">No active booking</p>
                  <p className="text-white/40 text-xs mt-0.5">Reserve a facility today</p>
                </>
              )}
            </div>
            {!todayBooking && upcoming.length === 0 && (
              <button onClick={() => setView('reserve')}
                className="bg-[#F5C900] text-[#262367] px-4 py-2 rounded-xl text-xs font-extrabold hover:bg-yellow-300 transition flex-shrink-0 shadow-md">
                Reserve
              </button>
            )}
            {todayBooking && (
              <div className="bg-white/10 rounded-xl px-3 py-2 text-center flex-shrink-0">
                <p className="text-[9px] font-bold uppercase tracking-wider text-white/40 mb-0.5">ID</p>
                <p className="text-xs font-black font-mono text-white">{todayBooking.id}</p>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── Available Facilities ── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className={`font-bold flex items-center gap-2 text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <Building2 size={15} className="text-[#262367]" /> Available Facilities
          </h3>
          <button onClick={() => setView('reserve')} className={`text-xs font-semibold inline-flex items-center gap-1 transition ${isDark ? 'text-[#262367] hover:text-[#35318c]' : 'text-[#262367] hover:text-[#35318c]'}`}>
            Reserve <ChevronRight size={13} />
          </button>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {ROOMS.map(room => {
            const fmtSlotShort = slot => {
              const parts = slot.replace(/–|—/g, '-').split('-').map(s => s.trim())
              if (parts.length < 2) return slot
              const fmt = t => t.replace(':00', '').replace(' ', '')
              return `${fmt(parts[0])}–${fmt(parts[1])}`
            }
            return (
              <div key={room.id} onClick={() => setView('reserve')}
                className={`rounded-2xl border p-3 hover:shadow-md transition-all group cursor-pointer flex flex-col ${isDark ? 'bg-white/5 border-white/10 hover:border-white/20' : 'bg-white border-gray-100 hover:border-[#262367]/20'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center group-hover:bg-white/15 transition flex-shrink-0 ${isDark ? 'bg-white/10' : 'bg-[#262367]/5 group-hover:bg-[#262367]/10'}`}>
                    <room.Icon size={13} className="text-[#262367]" />
                  </div>
                  <div className="min-w-0">
                    <p className={`font-bold text-[11px] leading-snug line-clamp-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{room.name}</p>
                    <p className={`text-[9px] ${isDark ? 'text-white/40' : 'text-gray-400'}`}>{room.capacityLabel}</p>
                  </div>
                </div>
                <p className={`text-[8px] font-bold uppercase tracking-widest mb-1 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>Today's Slots</p>
                <div className="space-y-1 flex-1">
                  {TIME_SLOTS.map(slot => {
                    const parsed = parseTimeSlot(slot, today)
                    const isPast = parsed ? Date.now() > parsed.endMs : false
                    const isBooked = (allBookings || []).some(b =>
                      b.room_id === room.id &&
                      b.booking_date === today &&
                      b.time === slot &&
                      ['Pending', 'Confirmed', 'Checked-In', 'Active'].includes(b.status)
                    )
                    return (
                      <div key={slot} className="flex items-center justify-between px-1 py-0.5">
                        <span className={`text-[9px] font-semibold ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                          {fmtSlotShort(slot)}
                        </span>
                        <span className={`text-[8px] font-bold px-2 py-0.5 rounded-full ${
                          isPast
                            ? isDark ? 'bg-white/10 text-white/40' : 'bg-gray-100 text-gray-500'
                            : isBooked
                              ? 'bg-red-500/20 text-red-400'
                              : isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          {isPast ? 'Past' : isBooked ? 'Booked' : 'Available'}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <button onClick={e => { e.stopPropagation(); setView('reserve') }}
                  className={`mt-2 w-full text-[11px] font-bold border rounded-xl py-1.5 transition-all ${
                    isDark
                      ? 'text-[#262367] border-[#262367]/40 hover:bg-[#262367] hover:text-white hover:border-[#262367]'
                      : 'text-[#262367] border-[#262367]/20 hover:bg-[#262367] hover:text-white hover:border-[#262367]'
                  }`}>
                  Reserve
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// RESERVE
// ─────────────────────────────────────────────────────────────

function Reserve({
  rooms,
  timeSlots,
  onSubmit,
  message,
  submitting,
  allBookings = [],
  profile
}) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [step, setStep] = useState(1)
  const [submittingLocal, setSubmittingLocal] = useState(false)
  const [selectedRoom, setSelectedRoom] = useState(rooms[0]?.id || '')
  const [selectedDate, setSelectedDate] = useState(localISO(new Date()))
  const [selectedTime, setSelectedTime] = useState(timeSlots[1] || timeSlots[0] || '')
  const [purpose, setPurpose] = useState('')
  const [groupSize, setGroupSize] = useState(1)

  function advance(n) { setStep(s => Math.max(s, n)) }

  const DAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const dates = (() => {
    const result = []
    const d = new Date()
    while (result.length < 5) {
      if (d.getDay() !== 0 && d.getDay() !== 6) result.push(new Date(d))
      d.setDate(d.getDate() + 1)
    }
    return result
  })()
  const room = rooms.find(r => r.id === selectedRoom)
  const PURPOSES = ['Thesis / Research', 'Group Study', 'Coding / Project', 'Seminar / Meeting', 'Individual Study', 'Other']

  const STEPS = [
    { n: 1, label: 'Date' },
    { n: 2, label: 'Facility' },
    { n: 3, label: 'Time Slot' },
    { n: 4, label: 'Details' },
  ]

  const isSubmitting = submitting || submittingLocal

  const handleFormSubmit = async (e) => {
    e.preventDefault()
    const cleanPurpose = purpose ? purpose.trim() : ''
    if (!cleanPurpose || cleanPurpose.length < 5) return
    await onSubmit(e, { selectedDate, selectedRoom, selectedTime, purpose, groupSize })
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">

      {/* ── Progress Steps ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-8 py-4 mb-5">
        <div className="flex items-center">
          {STEPS.map(({ n, label }, i) => {
            const done = step > n
            const active = step === n
            return (
              <div key={n} className="flex items-center flex-1">
                <div className="flex items-center gap-2.5 flex-shrink-0">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all shadow-sm
                    ${done ? 'bg-[#F5C900] text-[#262367]' : active ? 'bg-[#262367] text-white ring-4 ring-[#262367]/10' : 'bg-gray-100 text-gray-400'}`}>
                    {done ? <Check size={12} /> : n}
                  </div>
                  <span className={`text-xs font-semibold hidden sm:block ${active ? 'text-[#262367]' : done ? 'text-gray-400' : 'text-gray-300'}`}>
                    {label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-[2px] mx-3 rounded-full transition-all ${done ? 'bg-[#F5C900]' : 'bg-gray-100'}`} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <form onSubmit={handleFormSubmit} className="flex flex-col lg:flex-row gap-5">
        <div className="flex-1 space-y-4">

          {/* Step 1 – Date */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className={`flex items-center gap-2.5 px-5 py-3.5 border-b ${isDark ? 'border-white/[0.05]' : 'border-gray-100/60'}`}>
              <StepBadge n={1} step={step} />
              <p className="text-xs font-bold text-gray-600 uppercase tracking-widest flex items-center gap-1.5">
                <Calendar size={11} /> Select Date
              </p>
              <span className="ml-auto text-xs text-gray-400">Weekdays only</span>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-5 gap-2.5">
                {dates.map(d => {
                  const iso = localISO(d)
                  const sel = iso === selectedDate
                  const month = d.toLocaleDateString('en-US', { month: 'short' })
                  return (
                    <button key={iso} type="button" onClick={() => { setSelectedDate(iso); advance(2) }}
                      className={`flex flex-col items-center py-3.5 rounded-xl border-2 transition-all duration-150
                      ${sel
                          ? 'bg-[#262367] border-[#262367] text-white shadow-lg shadow-[#262367]/20'
                          : isDark
                            ? 'border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10'
                            : 'border-gray-150 bg-gray-50 text-gray-700 hover:border-[#262367]/30 hover:bg-[#262367]/5 hover:shadow-sm'}`}>
                      <span className={`text-[9px] font-bold uppercase tracking-widest ${sel ? 'text-white/50' : isDark ? 'text-white/40' : 'text-gray-400'}`}>{DAY[d.getDay()]}</span>
                      <span className={`text-2xl font-bold my-0.5 leading-none ${sel ? 'text-white' : isDark ? 'text-white/90' : 'text-gray-800'}`}>{d.getDate()}</span>
                      <span className={`text-[9px] font-semibold ${sel ? 'text-white/60' : isDark ? 'text-white/40' : 'text-gray-400'}`}>{month}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Step 2 – Facility */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className={`flex items-center gap-2.5 px-5 py-3.5 border-b ${isDark ? 'border-white/[0.05]' : 'border-gray-100/60'}`}>
              <StepBadge n={2} step={step} />
              <p className="text-xs font-bold text-gray-600 uppercase tracking-widest flex items-center gap-1.5">
                <Building2 size={11} /> Select Facility
              </p>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
              {rooms.map(r => {
                const ACTIVE_STATUSES = ['Pending', 'Confirmed', 'Checked-In', 'Active']
                const roomBookings = allBookings.filter(b => b.room_id === r.id && b.booking_date === selectedDate && ACTIVE_STATUSES.includes(b.status))
                const isFullyBooked = roomBookings.length >= timeSlots.length
                const sel = r.id === selectedRoom
                const isCollab = r.id.startsWith('collab')
                return (
                  <button key={r.id} type="button" disabled={isFullyBooked}
                    onClick={() => { setSelectedRoom(r.id); advance(3) }}
                    className={`relative text-left p-4 rounded-xl border-2 transition-all duration-150 group
                      ${isFullyBooked
                        ? 'border-red-200 bg-red-50/40 cursor-not-allowed opacity-75 animate-none'
                        : sel
                          ? 'border-[#262367] bg-[#262367]/[0.04] shadow-sm'
                          : 'border-gray-200 hover:border-[#262367]/30 hover:shadow-sm hover:bg-gray-50/80'}`}>

                    {isFullyBooked ? (
                      <div className="absolute top-3 right-3 bg-red-500 text-white text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full shadow-sm">
                        Fully Booked
                      </div>
                    ) : sel ? (
                      <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[#262367] flex items-center justify-center">
                        <Check size={10} className="text-white" />
                      </div>
                    ) : null}

                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3
                      ${isFullyBooked
                        ? 'bg-red-100 text-red-500'
                        : sel
                          ? 'bg-[#262367] shadow-md shadow-[#262367]/25'
                          : isCollab ? 'bg-blue-50' : 'bg-amber-50'}`}>
                      <r.Icon size={18} className={isFullyBooked ? 'text-red-500' : sel ? 'text-white' : isCollab ? 'text-blue-500' : 'text-amber-500'} />
                    </div>
                    <p className={`font-bold text-sm leading-snug ${isFullyBooked ? 'text-red-900' : sel ? 'text-[#262367]' : 'text-gray-900'}`}>{r.name}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">{r.location}</p>
                    <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full
                        ${isFullyBooked
                          ? 'bg-red-100 text-red-600'
                          : sel
                            ? 'bg-[#262367]/10 text-[#262367]'
                            : 'bg-gray-100 text-gray-500'}`}>
                        <Users size={9} /> {r.capacityLabel}
                      </span>
                      {isFullyBooked && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-50 border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">
                          All slots occupied
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Step 3 – Time Slot */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className={`flex items-center gap-2.5 px-5 py-3.5 border-b ${isDark ? 'border-white/[0.05]' : 'border-gray-100/60'}`}>
              <StepBadge n={3} step={step} />
              <p className="text-xs font-bold text-gray-600 uppercase tracking-widest flex items-center gap-1.5">
                <Clock size={11} /> Select Time Slot
              </p>
              <span className="ml-auto text-[10px] text-gray-400 font-medium">Sessions run 8:00 AM – 4:00 PM</span>
            </div>
            <div className="p-4 grid grid-cols-4 gap-2.5">
              {timeSlots.map(t => {
                const [start, end] = t.split(' – ')
                const activeBooking = allBookings.find(b =>
                  b.room_id === selectedRoom &&
                  b.booking_date === selectedDate &&
                  b.time === t &&
                  ['Pending', 'Confirmed', 'Checked-In', 'Active'].includes(b.status)
                )
                const isOwnBooking = activeBooking && activeBooking.student_id === profile?.student_id
                const isOtherBooking = activeBooking && activeBooking.student_id !== profile?.student_id
                const sel = selectedTime === t

                // Past-time check — slot is past if the END time has passed (same-day only)
                let isPast = false
                if (selectedDate) {
                  const today = localISO(new Date())
                  if (selectedDate === today) {
                    const m = end.match(/(\d+):(\d+)\s*(AM|PM)/i)
                    if (m) {
                      let h = parseInt(m[1], 10); const mm = parseInt(m[2], 10)
                      const period = m[3].toUpperCase()
                      if (period === 'PM' && h !== 12) h += 12
                      if (period === 'AM' && h === 12) h = 0

                      // Using manual parsing to match Session.jsx's timezone-safe approach
                      const [y, mon, dd] = selectedDate.split('-').map(Number)
                      const slotEnd = new Date(y, mon - 1, dd)
                      slotEnd.setHours(h, mm, 0, 0)
                      if (slotEnd.getTime() < Date.now()) isPast = true
                    }
                  } else if (selectedDate < today) {
                    isPast = true
                  }
                }

                let btnClasses = ""
                let badgeText = "2 hrs"
                let badgeClasses = ""
                let isDisabled = false

                if (isOwnBooking) {
                  isDisabled = true
                  btnClasses = isDark ? "border-blue-400/30 bg-blue-500/10 text-blue-300 cursor-not-allowed" : "border-blue-200 bg-blue-50/40 text-blue-800 cursor-not-allowed"
                  badgeText = "Your Booking"
                  badgeClasses = isDark ? "bg-blue-400/20 text-blue-300 font-bold" : "bg-blue-100 text-blue-700 font-bold"
                } else if (isOtherBooking) {
                  isDisabled = true
                  btnClasses = isDark ? "border-red-400/20 bg-red-500/10 text-white/40 cursor-not-allowed" : "border-red-200 bg-red-50/30 text-gray-500 cursor-not-allowed"
                  badgeText = "Reserved"
                  badgeClasses = isDark ? "bg-red-500/20 text-red-400 border border-red-400/20 font-bold" : "bg-red-100 text-red-600 border border-red-200 font-bold"
                } else if (isPast) {
                  isDisabled = true
                  btnClasses = isDark ? "border-white/5 bg-white/5 text-white/25 cursor-not-allowed opacity-60" : "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed opacity-60"
                  badgeText = "Past"
                  badgeClasses = isDark ? "bg-white/10 text-white/40 font-bold" : "bg-gray-300 text-gray-600 font-bold"
                } else {
                  isDisabled = false
                  if (sel) {
                    btnClasses = "bg-[#262367] border-[#262367] text-white shadow-lg shadow-[#262367]/20"
                    badgeText = "Available"
                    badgeClasses = "bg-white/20 text-white font-bold"
                  } else {
                    btnClasses = isDark ? "border-white/10 bg-white/5 text-white hover:border-white/20 hover:bg-white/10" : "border-gray-200 bg-gray-50 text-gray-800 hover:border-[#262367]/30 hover:bg-white hover:shadow-sm"
                    badgeText = "2 hrs"
                    badgeClasses = isDark ? "bg-white/15 text-white/70 font-semibold" : "bg-gray-200 text-gray-500 font-semibold"
                  }
                }

                return (
                  <button key={t} type="button" disabled={isDisabled}
                    onClick={() => { setSelectedTime(t); advance(4) }}
                    className={`flex flex-col items-center py-4 px-2 rounded-xl border-2 transition-all duration-150 flex-1 min-w-[120px] ${btnClasses}`}>
                    <span className={`text-xs font-extrabold ${sel ? 'text-white' : isDark ? 'text-white/90' : 'text-gray-800'}`}>{start}</span>
                    <div className={`w-4 h-px my-1.5 ${sel ? 'bg-white/30' : isDark ? 'bg-white/20' : 'bg-gray-300'}`} />
                    <span className={`text-[10px] ${sel ? 'text-white/60' : isDark ? 'text-white/40' : 'text-gray-400'}`}>{end}</span>
                    <span className={`text-[9px] mt-2 font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${badgeClasses}`}>
                      {badgeText}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Step 4 – Details */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className={`flex items-center gap-2.5 px-5 py-3.5 border-b ${isDark ? 'border-white/[0.05]' : 'border-gray-100/60'}`}>
              <StepBadge n={4} step={step} done={!!purpose} />
              <p className="text-xs font-bold text-gray-600 uppercase tracking-widest">Details</p>
            </div>
            <div className="p-4 grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="booking-purpose" className="block text-xs font-semibold text-gray-600 mb-1.5">Purpose <span className="text-red-400">*</span></label>
                <select id="booking-purpose" name="purpose" autoComplete="off" value={purpose} onChange={e => { setPurpose(e.target.value) }} required
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#262367]/20 focus:border-[#262367] focus:bg-white transition appearance-none cursor-pointer">
                  <option value="">Select purpose…</option>
                  {PURPOSES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="booking-group-size" className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Group Size
                  <span className="text-gray-400 font-normal ml-1">(1 – 8 persons)</span>
                </label>
                <input id="booking-group-size" name="group-size" type="number" autoComplete="off" min={1} max={8} value={groupSize}
                  onChange={e => setGroupSize(Math.min(8, Math.max(1, +e.target.value || 1)))}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#262367]/20 focus:border-[#262367] focus:bg-white transition" />
              </div>
            </div>
          </div>
        </div>

        {/* ── Summary sidebar ── */}
        <div className="w-full lg:w-68 flex-shrink-0" style={{ width: '268px' }}>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden sticky top-24">
            {/* Header */}
            <div className="px-5 py-4 bg-[#262367] text-white">
              <p className="text-[10px] font-bold text-white/50 uppercase tracking-widest">Booking Summary</p>
              <p className="text-sm font-bold text-white mt-0.5">{room?.name || 'No facility selected'}</p>
            </div>

            <div className="px-5 py-4 space-y-0 divide-y divide-white/10">
              {[
                { label: 'Date', value: selectedDate ? new Date(selectedDate + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—' },
                { label: 'Time', value: selectedTime || '—' },
                { label: 'Duration', value: '2 hours' },
                { label: 'Purpose', value: purpose || '—' },
                { label: 'Group Size', value: groupSize },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between items-center py-2.5">
                  <span className="text-xs text-gray-400">{label}</span>
                  <span className="text-xs font-semibold text-gray-900 text-right max-w-[55%] truncate">{value}</span>
                </div>
              ))}
            </div>

            <div className="px-5 pb-5">
              {message && (
                <div className={`mb-3 p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
                  {message.type === 'success' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                  {message.text}
                </div>
              )}

              <button type="submit" disabled={isSubmitting || !purpose}
                className="w-full py-3 rounded-xl font-bold transition disabled:opacity-40 flex items-center justify-center gap-2 text-sm shadow-lg bg-[#262367] hover:bg-[#35318c] text-white shadow-[#262367]/20">
                {isSubmitting
                  ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Processing…</>
                  : <><Calendar size={14} /> Confirm Reservation</>
                }
              </button>
              {!purpose && (
                <p className="text-[11px] text-amber-500 mt-2 text-center font-medium">Select a purpose to continue</p>
              )}
              <p className="text-xs text-amber-600 mt-2 text-center font-medium flex items-center justify-center gap-1">
                <Timer size={11} /> Cancellable within 15 min of booking
              </p>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}

function StepBadge({ n, step, done }) {
  const isDone = done !== undefined ? done : step > n
  const isActive = !isDone && step === n
  return (
    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 transition-all
      ${isDone ? 'bg-[#F5C900] text-[#262367]' : isActive ? 'bg-[#262367] text-white' : 'bg-gray-200 text-gray-400'}`}>
      {isDone ? <Check size={10} /> : n}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// RESERVATIONS
// ─────────────────────────────────────────────────────────────

// Helper: compute ms remaining in 15-min cancel window
function getCancelMsLeft(booking, now) {
  const createdMs = booking.created_at?.seconds
    ? booking.created_at.seconds * 1000
    : new Date(booking.created_at || 0).getTime()
  return Math.max(0, CANCEL_WINDOW_MS - (now - createdMs))
}

function CancelCountdown({ msLeft }) {
  if (msLeft <= 0) return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] text-gray-400 font-medium">
      <Timer size={10} /> Window closed
    </span>
  )
  const mins = Math.floor(msLeft / 60000)
  const secs = Math.floor((msLeft % 60000) / 1000)
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] text-amber-600 font-bold bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
      <Timer size={10} className="animate-pulse" />
      {mins}m {secs}s left
    </span>
  )
}

function Reservations({ bookings, setView, statusStyles, onDelete, onCancel, now, onReceipt }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const cancellable = ['Pending', 'Confirmed']

  if (bookings.length === 0) return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-[#262367]/5 flex items-center justify-center mx-auto mb-4">
          <ClipboardList className="w-7 h-7 text-[#262367]/30" />
        </div>
        <p className="font-bold text-gray-700 mb-1">No reservations yet</p>
        <p className="text-gray-400 text-sm">Book a facility to get started.</p>
        <button onClick={() => setView('reserve')}
          className="mt-5 bg-[#262367] text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-[#35318c] transition inline-flex items-center gap-2 shadow-md">
          <Calendar size={14} /> Reserve Now
        </button>
      </div>
    </div>
  )

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      {/* ── Bookings table ── */}
      {bookings.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold text-gray-900 text-lg">All Reservations</h3>
              <p className="text-xs text-gray-400 mt-0.5">{bookings.length} total booking{bookings.length !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={() => setView('reserve')}
              className="bg-[#262367] text-white px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-[#35318c] transition inline-flex items-center gap-2 shadow-md">
              <Calendar size={14} /> New Reservation
            </button>
          </div>

          {/* Cancel policy notice */}
          <div className="mb-3 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
            <Timer size={13} className="mt-0.5 flex-shrink-0" />
            <span><strong>Cancellation Policy:</strong> You may cancel a reservation within <strong>15 minutes</strong> of submitting it. After that, the reservation is locked and only admin can modify it.</span>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {['Booking ID', 'Facility', 'Date', 'Time', 'Status', 'Confirmed At', 'Cancel Window', 'Actions'].map(h => (
                    <th key={h} className="text-left px-3 py-3.5 text-xs font-bold text-gray-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? 'divide-white/[0.06]' : 'divide-gray-50'}`}>
                {bookings.map(b => {
                  const msLeft = getCancelMsLeft(b, now)
                  const canCancel = cancellable.includes(b.status) && msLeft > 0
                  return (
                    <tr key={b.id} className={`transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50/60'}`}>
                      <td className="px-3 py-4 font-mono text-xs font-bold text-[#262367]">{b.id}</td>
                      <td className={`px-3 py-4 font-medium text-xs ${isDark ? 'text-white' : 'text-gray-900'}`}>{b.room_name || b.facility}</td>
                      <td className={`px-3 py-4 text-xs whitespace-nowrap ${isDark ? 'text-white/50' : 'text-gray-500'}`}>{b.date || b.booking_date}</td>
                      <td className={`px-3 py-4 text-xs whitespace-nowrap ${isDark ? 'text-white/50' : 'text-gray-500'}`}>{b.time}</td>
                      <td className="px-3 py-4">
                        <span className={`inline-block whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-bold ${statusStyles[b.status] || 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                          {b.status}
                        </span>
                        {b.status === 'Cancelled' && b.rejection_reason && (
                          <p className="text-[10px] text-red-400 mt-1 max-w-[140px]" title={b.rejection_reason}>
                            Reason: {b.rejection_reason}
                          </p>
                        )}
                      </td>
                      <td className={`px-3 py-4 text-xs whitespace-nowrap ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                        {b.confirmed_at
                          ? new Date((b.confirmed_at.seconds || 0) * 1000 || b.confirmed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                          : <span className={isDark ? 'text-white/20' : 'text-gray-300'}>—</span>
                        }
                      </td>
                      <td className="px-3 py-4 whitespace-nowrap">
                        {cancellable.includes(b.status)
                          ? <CancelCountdown msLeft={msLeft} />
                          : <span className={`text-[10px] ${isDark ? 'text-white/20' : 'text-gray-300'}`}>—</span>
                        }
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex items-center gap-1.5 flex-nowrap">
                          {['Confirmed', 'Checked-In', 'Active'].includes(b.status) && (
                            <button
                              onClick={() => onReceipt(b)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#262367] text-white text-xs font-semibold hover:bg-[#35318c] transition whitespace-nowrap shadow-sm"
                              title="View and download booking receipt"
                            >
                              <Download size={11} /> Receipt
                            </button>
                          )}
                          {canCancel && (
                            <button
                              onClick={() => onCancel(b)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100 border border-red-200 transition whitespace-nowrap"
                              title="Cancel within 15-min window"
                            >
                              <X size={11} /> Cancel
                            </button>
                          )}
                          {['Done', 'Cancelled', 'No-Show'].includes(b.status) && (
                            <button onClick={() => onDelete(b.docId)} className="w-7 h-7 rounded-lg bg-red-50 text-red-400 flex items-center justify-center hover:bg-red-100 border border-red-100 transition" title="Delete record">
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ACCOUNT SETTINGS
// ─────────────────────────────────────────────────────────────

function AccountSettings({ profile, setProfile }) {
  const { theme, setTheme } = useTheme()
  const [preferredName, setPreferredName] = useState(profile?.preferred_name || profile?.name || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoMsg, setPhotoMsg] = useState(null);
  const [alertConfig, setAlertConfig] = useState(null);

  // Recovery State
  const [recoveryEmail, setRecoveryEmail] = useState(profile?.recovery_email || '');
  const [recoveryQuestion, setRecoveryQuestion] = useState(profile?.recovery_question || '');
  // Answer is stored hashed — never pre-fill, always require fresh entry on edit.
  const [recoveryAnswer, setRecoveryAnswer] = useState('');
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [recoveryMsg, setRecoveryMsg] = useState(null);

  const missingRecovery = !profile?.recovery_email || !profile?.recovery_question || !profile?.recovery_answer;

  const BAD_WORDS = ['fuck', 'shit', 'bitch', 'ass', 'cunt', 'dick', 'pussy', 'whore', 'slut', 'fag', 'nigger', 'nigga', 'bastard', 'idiot', 'stupid', 'dumb', 'asshole', 'putangina', 'gago', 'tarantado', 'bobo', 'inutil', 'tangina', 'buraot'];

  const PHOTO_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000; // ~3 months
  const photoUpdatedAt = profile?.photo_updated_at?.seconds
    ? profile.photo_updated_at.seconds * 1000
    : (typeof profile?.photo_updated_at === 'number' ? profile.photo_updated_at : null);
  const photoLockUntil = photoUpdatedAt ? photoUpdatedAt + PHOTO_COOLDOWN_MS : 0;
  const photoLocked = photoLockUntil > Date.now();
  const daysUntilUnlock = photoLocked ? Math.ceil((photoLockUntil - Date.now()) / (24 * 60 * 60 * 1000)) : 0;
  const unlockDate = photoLocked ? new Date(photoLockUntil).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';

  // Crop modal state
  const VIEW_SIZE = 256;
  const OUT_SIZE = 320;
  const [cropSrc, setCropSrc] = useState(null);
  const [cropImg, setCropImg] = useState(null);  // HTMLImageElement
  const [cropScale, setCropScale] = useState(1);
  const [cropPos, setCropPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  const handlePhotoUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoMsg(null);
    if (photoLocked) {
      setPhotoMsg({ type: 'error', text: `You can change your photo again on ${unlockDate}.` });
      return;
    }
    if (!file.type.startsWith('image/')) {
      setPhotoMsg({ type: 'error', text: 'Please choose an image file.' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoMsg({ type: 'error', text: 'Image must be 5 MB or smaller.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      const im = new Image();
      im.onload = () => {
        // Fit shorter side to viewport, then allow zoom up
        const baseScale = VIEW_SIZE / Math.min(im.width, im.height);
        setCropImg(im);
        setCropScale(baseScale);
        setCropPos({
          x: (VIEW_SIZE - im.width * baseScale) / 2,
          y: (VIEW_SIZE - im.height * baseScale) / 2,
        });
        setCropSrc(url);
      };
      im.src = url;
    };
    reader.readAsDataURL(file);
  };

  function clampPos(pos, scale, img) {
    const w = img.width * scale;
    const h = img.height * scale;
    return {
      x: Math.min(0, Math.max(VIEW_SIZE - w, pos.x)),
      y: Math.min(0, Math.max(VIEW_SIZE - h, pos.y)),
    };
  }

  function handleCropMouseDown(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = { ...cropPos };
    const onMove = (ev) => {
      const next = clampPos(
        { x: startPos.x + (ev.clientX - startX), y: startPos.y + (ev.clientY - startY) },
        cropScale,
        cropImg,
      );
      setCropPos(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleZoomChange(value) {
    if (!cropImg) return;
    const newScale = parseFloat(value);
    // Re-center around the viewport midpoint when zooming
    const midX = VIEW_SIZE / 2;
    const midY = VIEW_SIZE / 2;
    const imgPointX = (midX - cropPos.x) / cropScale;
    const imgPointY = (midY - cropPos.y) / cropScale;
    const newPos = clampPos(
      { x: midX - imgPointX * newScale, y: midY - imgPointY * newScale },
      newScale,
      cropImg,
    );
    setCropScale(newScale);
    setCropPos(newPos);
  }

  const handleCropConfirm = async () => {
    if (!cropImg) return;
    setPhotoUploading(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUT_SIZE;
      canvas.height = OUT_SIZE;
      const ctx = canvas.getContext('2d');
      // The visible viewport in source-image pixels:
      const sx = (-cropPos.x) / cropScale;
      const sy = (-cropPos.y) / cropScale;
      const sSize = VIEW_SIZE / cropScale;
      ctx.drawImage(cropImg, sx, sy, sSize, sSize, 0, 0, OUT_SIZE, OUT_SIZE);
      const out = canvas.toDataURL('image/jpeg', 0.82);

      const nowMs = Date.now();
      if (profile?.uid && !sessionStorage.getItem('dev_user')) {
        await updateDoc(doc(db, 'users', profile.uid), {
          photo_url: out,
          photo_updated_at: serverTimestamp(),
        });
      }
      setProfile(prev => ({
        ...prev,
        photo_url: out,
        photo_updated_at: { seconds: Math.floor(nowMs / 1000) },
      }));
      setPhotoMsg({ type: 'success', text: 'Profile photo updated. You can change it again in 3 months.' });
      setCropSrc(null);
      setCropImg(null);
    } catch (err) {
      console.error(err);
      setPhotoMsg({ type: 'error', text: 'Failed to upload photo. Try a smaller image.' });
    }
    setPhotoUploading(false);
  };

  const performDeletePhoto = async () => {
    setPhotoUploading(true);
    try {
      if (profile?.uid && !sessionStorage.getItem('dev_user')) {
        // Keep photo_updated_at intact so cooldown still applies
        await updateDoc(doc(db, 'users', profile.uid), { photo_url: null });
      }
      setProfile(prev => ({ ...prev, photo_url: null }));
      setPhotoMsg({ type: 'success', text: 'Photo deleted. You can upload a new one once the cooldown ends.' });
    } catch (err) {
      console.error(err);
      setPhotoMsg({ type: 'error', text: 'Failed to delete photo.' });
    }
    setPhotoUploading(false);
  };

  const handleDeletePhoto = () => {
    if (!profile?.photo_url) return;
    setAlertConfig({
      type: 'confirm',
      variant: 'danger',
      destructive: true,
      title: 'Delete profile photo?',
      message: 'Your photo will be removed from your account. You will not be able to upload a new one until the 3-month cooldown ends.',
      confirmLabel: 'Delete photo',
      onConfirm: performDeletePhoto,
    });
  };

  const handleSave = async () => {
    const cleanPrefName = sanitizeText(preferredName).trim();
    if (!cleanPrefName) {
      setMsg({ type: 'error', text: 'Preferred name cannot be empty.' });
      return;
    }

    const isProfane = BAD_WORDS.some(word => cleanPrefName.toLowerCase().includes(word));
    if (isProfane) {
      setMsg({ type: 'error', text: 'Please use appropriate language.' });
      return;
    }

    setSaving(true);
    setMsg(null);
    try {
      if (profile?.uid && !sessionStorage.getItem('dev_user')) {
        await updateDoc(doc(db, 'users', profile.uid), { preferred_name: cleanPrefName });
      }
      setProfile(prev => ({ ...prev, preferred_name: cleanPrefName }));
      setMsg({ type: 'success', text: 'Preferred name updated successfully.' });
    } catch (err) {
      console.error(err);
      setMsg({ type: 'error', text: 'Failed to update preferred name.' });
    }
    setSaving(false);
  };

  const handleSaveRecovery = async () => {
    const cleanEmail = sanitizeText(recoveryEmail).trim();
    const cleanQuestion = sanitizeText(recoveryQuestion).trim();
    const cleanAnswer = sanitizeText(recoveryAnswer).trim();

    if (!cleanEmail || !cleanQuestion || !cleanAnswer) {
      setRecoveryMsg({ type: 'error', text: 'All recovery fields are required.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setRecoveryMsg({ type: 'error', text: 'Please enter a valid email address.' });
      return;
    }

    setRecoverySaving(true);
    setRecoveryMsg(null);
    try {
      // Hash the answer before storing — case-insensitive, trimmed.
      // Even if someone reads the user doc, they only see the hash.
      const answerHash = await sha256(cleanAnswer.toLowerCase());
      if (profile?.uid && !sessionStorage.getItem('dev_user')) {
        await updateDoc(doc(db, 'users', profile.uid), {
          recovery_email: cleanEmail,
          recovery_question: cleanQuestion,
          recovery_answer: answerHash
        });
      }
      setProfile(prev => ({
        ...prev,
        recovery_email: cleanEmail,
        recovery_question: cleanQuestion,
        recovery_answer: answerHash
      }));
      setRecoveryMsg({ type: 'success', text: 'Recovery details saved successfully.' });
    } catch (err) {
      console.error(err);
      setRecoveryMsg({ type: 'error', text: 'Failed to save recovery details.' });
    }
    setRecoverySaving(false);
  };

  return (
    <div className="max-w-4xl mx-auto py-10 px-4 sm:px-6 lg:px-8 animate-in fade-in duration-300">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Account Settings</h2>
        <p className="text-sm text-gray-500 mt-1">Manage your account preferences and personal information.</p>
      </div>

      <div className="space-y-6">
        {/* Profile Card */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm flex flex-col sm:flex-row items-center sm:items-start gap-6">
          <div className="relative group">
            <img
              src={profile?.photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.preferred_name || profile?.name || 'Student')}&background=f3f4f6&color=374151&size=160&rounded=true`}
              className="w-20 h-20 rounded-full border border-gray-200 object-cover bg-gray-50" alt="Profile"
            />
            <label
              htmlFor="photo-upload-input"
              title={photoLocked ? `Available again on ${unlockDate}` : 'Change profile photo'}
              className={`absolute inset-0 rounded-full flex items-center justify-center transition ${photoLocked
                ? 'bg-black/0 cursor-not-allowed'
                : 'bg-black/0 hover:bg-black/40 cursor-pointer'
                }`}
            >
              {!photoLocked && (
                <div className="opacity-0 group-hover:opacity-100 transition flex flex-col items-center text-white">
                  {photoUploading
                    ? <RefreshCw className="w-5 h-5 animate-spin" />
                    : <Camera className="w-5 h-5" />}
                </div>
              )}
              {photoLocked && (
                <div className="absolute -bottom-1 -right-1 bg-gray-700 text-white rounded-full w-7 h-7 flex items-center justify-center border-2 border-white shadow-sm">
                  <Lock className="w-3 h-3" />
                </div>
              )}
            </label>
            <input
              id="photo-upload-input"
              type="file"
              accept="image/*"
              onChange={handlePhotoUpload}
              disabled={photoLocked || photoUploading}
              className="hidden"
            />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <h3 className="text-xl font-bold text-gray-900">{profile?.preferred_name || profile?.name || 'Student Name'}</h3>
            <p className="text-sm text-gray-500 font-medium">{profile?.email || 'student@domain.edu.ph'}</p>
            {photoMsg && (
              <p className={`text-xs mt-2 flex items-center justify-center sm:justify-start gap-1.5 font-medium ${photoMsg.type === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
                {photoMsg.type === 'error' ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
                {photoMsg.text}
              </p>
            )}
            {!photoMsg && photoLocked && (
              <p className="text-xs mt-2 text-gray-400 flex items-center justify-center sm:justify-start gap-1.5">
                <Lock size={11} /> Photo can be changed again in {daysUntilUnlock} day{daysUntilUnlock === 1 ? '' : 's'} ({unlockDate}).
              </p>
            )}
            {!photoMsg && !photoLocked && (
              <p className="text-xs mt-2 text-gray-400 flex items-center justify-center sm:justify-start gap-1.5">
                <Camera size={11} /> Click your photo to upload. You can adjust the crop before saving. Changes are locked for 3 months after.
              </p>
            )}
            {profile?.photo_url && (
              <button
                onClick={handleDeletePhoto}
                disabled={photoUploading}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50 transition"
              >
                <Trash2 size={12} /> Delete profile photo
              </button>
            )}
          </div>
          <div className="mt-2 sm:mt-0">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${profile?.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
              {profile?.status === 'ACTIVE' ? 'Active Account' : 'Inactive'}
            </span>
          </div>
        </div>

        {/* Preferred Name Section */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-900 tracking-tight">Preferred Name</h3>
            <p className="text-sm text-gray-500 mt-1">This is how you will be identified on the dashboard.</p>

            <div className="mt-6 flex flex-col gap-2">
              <label htmlFor="preferred-name" className="sr-only">Preferred Name</label>
              <input
                id="preferred-name" name="preferred-name"
                type="text" autoComplete="given-name"
                value={preferredName}
                onChange={(e) => setPreferredName(e.target.value)}
                placeholder="Enter preferred name"
                className="w-full max-w-md px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#262367] focus:border-transparent transition text-sm text-gray-900 font-medium shadow-sm"
              />
              {msg && (
                <p className={`text-sm mt-1.5 flex items-center gap-1.5 font-medium ${msg.type === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
                  {msg.type === 'error' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                  {msg.text}
                </p>
              )}
            </div>
          </div>
          <div className="bg-gray-50 px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs text-gray-500 font-medium text-center sm:text-left">
              Please use appropriate language. Obscene words will not be saved.
            </p>
            <button
              onClick={handleSave}
              disabled={saving || preferredName === (profile?.preferred_name || profile?.name)}
              className="w-full sm:w-auto px-5 py-2.5 bg-[#262367] text-white rounded-lg font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#1a1745] transition shadow-sm"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>

        {/* Appearance */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-900 tracking-tight">Appearance</h3>
            <p className="text-sm text-gray-500 mt-1">Choose how LCspace looks for you.</p>
          </div>
          <div className="p-6">
            <div className="flex gap-4 max-w-sm">
              {[
                {
                  key: 'light', Icon: Sun, label: 'Light',
                  pageBg: '#F0F4FF', sidebarBg: '#262367', cardBg: '#ffffff', cardBorder: '#e5e7eb',
                },
                {
                  key: 'dark', Icon: Moon, label: 'Dark',
                  pageBg: '#0d0c1a', sidebarBg: '#100f22', cardBg: '#1c1a2e', cardBorder: '#2a2840',
                },
              ].map(({ key, Icon, label, pageBg, sidebarBg, cardBg, cardBorder }) => (
                <button key={key} onClick={() => setTheme(key)}
                  className={`flex-1 rounded-xl border-2 overflow-hidden transition-all text-left
                    ${theme === key ? 'border-[#262367] shadow-lg shadow-[#262367]/15' : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'}`}>
                  {/* Mini UI preview */}
                  <div className="h-20 flex" style={{ background: pageBg }}>
                    <div className="w-7 h-full flex-shrink-0" style={{ background: sidebarBg }} />
                    <div className="flex-1 p-1.5 flex flex-col gap-1">
                      <div className="h-2 rounded-sm w-full" style={{ background: cardBg, border: `1px solid ${cardBorder}` }} />
                      <div className="h-2 rounded-sm w-4/5" style={{ background: cardBg, border: `1px solid ${cardBorder}` }} />
                      <div className="h-2 rounded-sm w-full" style={{ background: cardBg, border: `1px solid ${cardBorder}` }} />
                      <div className="h-2 rounded-sm w-3/5" style={{ background: cardBg, border: `1px solid ${cardBorder}` }} />
                    </div>
                  </div>
                  <div className={`flex items-center justify-between px-3 py-2.5 ${theme === key ? 'bg-[#262367]/5' : 'bg-white'}`}>
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} className={theme === key ? 'text-[#262367]' : 'text-gray-400'} />
                      <span className={`text-xs font-semibold ${theme === key ? 'text-[#262367]' : 'text-gray-600'}`}>{label}</span>
                    </div>
                    {theme === key && <Check size={13} className="text-[#262367]" />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Account Recovery Section */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-gray-900 tracking-tight flex items-center gap-2">
                Account Recovery
                {missingRecovery && <span className="flex w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]" title="Missing recovery setup"></span>}
              </h3>
              <p className="text-sm text-gray-500 mt-1">Set up recovery details to regain access if you forget your password.</p>
            </div>
          </div>
          <div className="p-6 space-y-5">
            {missingRecovery && (
              <div className="bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3 rounded-xl flex items-start gap-3 shadow-sm">
                <AlertTriangle size={18} className="text-red-600 mt-0.5 flex-shrink-0" />
                <p><strong>Action Required:</strong> Please configure your recovery email and security question. This is required to reset your password if you lose access to your account.</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="md:col-span-2">
                <label htmlFor="recovery-email" className="block text-sm font-semibold text-gray-700 mb-1.5">Recovery Email</label>
                <input
                  id="recovery-email" name="recovery-email"
                  type="email" autoComplete="email"
                  value={recoveryEmail}
                  onChange={(e) => setRecoveryEmail(e.target.value)}
                  placeholder="e.g. personal@example.com"
                  className="w-full max-w-md px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#262367] focus:border-transparent transition text-sm text-gray-900 shadow-sm"
                />
              </div>
              <div>
                <label htmlFor="recovery-question" className="block text-sm font-semibold text-gray-700 mb-1.5">Security Question</label>
                <select
                  id="recovery-question" name="recovery-question"
                  autoComplete="off"
                  value={recoveryQuestion}
                  onChange={(e) => setRecoveryQuestion(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#262367] focus:border-transparent transition text-sm text-gray-900 shadow-sm bg-white"
                >
                  <option value="" disabled>Select a question...</option>
                  <option value="What was the name of your first pet?">What was the name of your first pet?</option>
                  <option value="In what city were you born?">In what city were you born?</option>
                  <option value="What is your mother's maiden name?">What is your mother's maiden name?</option>
                  <option value="What was the model of your first car?">What was the model of your first car?</option>
                  <option value="What was the name of your elementary school?">What was the name of your elementary school?</option>
                  <option value="Enter your own recovery PIN code">Enter your own recovery PIN code</option>
                </select>
              </div>
              <div>
                <label htmlFor="recovery-answer" className="block text-sm font-semibold text-gray-700 mb-1.5">Answer / PIN Code</label>
                <input
                  id="recovery-answer" name="recovery-answer"
                  type="text" autoComplete="off"
                  value={recoveryAnswer}
                  onChange={(e) => setRecoveryAnswer(e.target.value)}
                  placeholder="Your answer or code"
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#262367] focus:border-transparent transition text-sm text-gray-900 shadow-sm"
                />
              </div>
            </div>

            {recoveryMsg && (
              <p className={`text-sm flex items-center gap-1.5 font-medium ${recoveryMsg.type === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
                {recoveryMsg.type === 'error' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                {recoveryMsg.text}
              </p>
            )}
          </div>
          <div className="bg-gray-50 px-6 py-4 flex justify-end border-t border-gray-100">
            <button
              onClick={handleSaveRecovery}
              disabled={recoverySaving}
              className="px-5 py-2.5 bg-[#262367] text-white rounded-lg font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#1a1745] transition shadow-sm"
            >
              {recoverySaving ? 'Saving...' : 'Save Recovery Details'}
            </button>
          </div>
        </div>

        {/* Read-Only Data */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
          <div className="p-6 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-gray-900 tracking-tight">Institutional Details</h3>
              <p className="text-sm text-gray-500 mt-1">Official data synced from the university registrar.</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 bg-gray-100 px-3 py-1.5 rounded-md">
              <Lock size={12} /> Read-only
            </div>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl">
              <div>
                <label htmlFor="inst-name" className="block text-sm font-semibold text-gray-700 mb-1.5">Legal Full Name</label>
                <input id="inst-name" name="full-name" type="text" autoComplete="name" disabled defaultValue={profile?.name || ''}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 text-sm cursor-not-allowed font-medium" />
              </div>
              <div>
                <label htmlFor="inst-student-id" className="block text-sm font-semibold text-gray-700 mb-1.5">Student ID</label>
                <input id="inst-student-id" name="student-id" type="text" autoComplete="off" disabled defaultValue={profile?.student_id || ''}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 text-sm cursor-not-allowed font-medium" />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="inst-department" className="block text-sm font-semibold text-gray-700 mb-1.5">School Department</label>
                <input id="inst-department" name="department" type="text" autoComplete="organization" disabled defaultValue={profile?.department || 'Not assigned'}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 text-sm cursor-not-allowed font-medium" />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="inst-email" className="block text-sm font-semibold text-gray-700 mb-1.5">Institutional Email</label>
                <input id="inst-email" name="email" type="email" autoComplete="email" disabled defaultValue={profile?.email || ''}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 text-sm cursor-not-allowed font-medium" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <AlertModal config={alertConfig} onClose={() => setAlertConfig(null)} />

      {/* Crop Modal */}
      {cropSrc && cropImg && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Adjust your photo</h3>
                <p className="text-[11px] text-gray-500 mt-0.5">Drag to reposition · use the slider to zoom</p>
              </div>
              <button
                onClick={() => { setCropSrc(null); setCropImg(null); }}
                disabled={photoUploading}
                className="text-gray-400 hover:text-gray-700 p-1.5 rounded-md hover:bg-gray-100 transition disabled:opacity-50"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 flex flex-col items-center gap-4">
              {/* Crop viewport */}
              <div
                ref={dragRef}
                onMouseDown={handleCropMouseDown}
                style={{ width: VIEW_SIZE, height: VIEW_SIZE }}
                className="relative bg-gray-900 rounded-full overflow-hidden select-none cursor-grab active:cursor-grabbing shadow-inner"
              >
                <img
                  src={cropSrc}
                  draggable={false}
                  alt="Crop preview"
                  style={{
                    position: 'absolute',
                    left: cropPos.x,
                    top: cropPos.y,
                    width: cropImg.width * cropScale,
                    height: cropImg.height * cropScale,
                    maxWidth: 'none',
                    pointerEvents: 'none',
                  }}
                />
                <div className="absolute inset-0 ring-2 ring-white/30 rounded-full pointer-events-none" />
              </div>

              {/* Zoom slider */}
              <div className="w-full flex items-center gap-3">
                <Camera size={14} className="text-gray-400" />
                <input
                  type="range"
                  min={(VIEW_SIZE / Math.min(cropImg.width, cropImg.height)).toFixed(3)}
                  max={(VIEW_SIZE / Math.min(cropImg.width, cropImg.height) * 4).toFixed(3)}
                  step="0.01"
                  value={cropScale}
                  onChange={e => handleZoomChange(e.target.value)}
                  className="flex-1 accent-[#262367]"
                />
                <Camera size={18} className="text-gray-600" />
              </div>
            </div>

            <div className="bg-gray-50 px-6 py-4 flex items-center justify-end gap-3 border-t border-gray-100">
              <button
                onClick={() => { setCropSrc(null); setCropImg(null); }}
                disabled={photoUploading}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-white transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCropConfirm}
                disabled={photoUploading}
                className="px-5 py-2 rounded-lg bg-[#262367] text-white text-sm font-semibold hover:bg-[#1a1745] transition disabled:opacity-50 flex items-center gap-2"
              >
                {photoUploading
                  ? <><RefreshCw size={14} className="animate-spin" /> Saving…</>
                  : <>Save Photo</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// STUDENT MAIL & HELP COMPONENTS
// ─────────────────────────────────────────────────────────────

function StudentMail({ profile }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const navigate = useNavigate()
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [composing, setComposing] = useState(false)
  const [composeSubject, setComposeSubject] = useState('')
  const [composeMessage, setComposeMessage] = useState('')
  const [composeSending, setComposeSending] = useState(false)
  const [composeStatus, setComposeStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('inbox') // 'inbox' | 'sent'
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyMessage, setReplyMessage] = useState('')

  // Opening Mail marks all unread direct messages as read — this clears the
  // yellow "unseen" dot in the sidebar (and flips the admin's receipt to Seen).
  useEffect(() => {
    if (!profile?.uid) return
    messages.forEach(m => {
      if (m.recipient_uid === profile.uid && m.direction !== 'from_student' && !m.read && !m.id?.startsWith('local')) {
        updateDoc(doc(db, 'admin_messages', m.id), { read: true, read_at: serverTimestamp() }).catch(() => { })
      }
    })
  }, [messages, profile?.uid])

  useEffect(() => {
    if (!profile?.uid) { setLoading(false); return }
    if (sessionStorage.getItem('dev_user')) {
      const localFallback = JSON.parse(localStorage.getItem('lcspace_messages') || '[]')
      setMessages(
        localFallback
          .filter(m => m.recipient_id === 'all' || m.recipient_uid === profile.uid || m.sender_uid === profile.uid)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      )
      setLoading(false)
      return
    }

    // Two parallel queries: messages addressed to this user (by uid) and broadcast messages
    let msgs1 = [], msgs2 = [], msgs3 = []
    const dismissed = () => new Set(JSON.parse(localStorage.getItem('lcspace_dismissed_msgs') || '[]'))

    const merge = () => {
      const allMsgs = [...msgs1, ...msgs2, ...msgs3]
      const unique = Array.from(new Map(allMsgs.map(m => [m.id, m])).values())
      const d = dismissed()
      const filtered = unique.filter(m => !d.has(m.id) && !m.hidden_for_student)
      filtered.sort((a, b) => {
        const ta = a.created_at?.seconds ? a.created_at.seconds * 1000 : new Date(a.created_at || 0).getTime()
        const tb = b.created_at?.seconds ? b.created_at.seconds * 1000 : new Date(b.created_at || 0).getTime()
        return tb - ta
      })
      setMessages(filtered)
      setLoading(false)
    }

    const q1 = query(collection(db, 'admin_messages'), where('recipient_uid', '==', profile.uid))
    const unsub1 = onSnapshot(q1, snap => {
      msgs1 = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      merge()
    }, err => { console.warn('Messages query error:', err.message); setLoading(false) })

    const q2 = query(collection(db, 'admin_messages'), where('recipient_id', '==', 'all'))
    const unsub2 = onSnapshot(q2, snap => {
      msgs2 = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      merge()
    }, err => { console.warn('Broadcasts query error:', err.message) })

    const q3 = query(collection(db, 'admin_messages'), where('sender_uid', '==', profile.uid))
    const unsub3 = onSnapshot(q3, snap => {
      msgs3 = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      merge()
    }, err => { console.warn('Sent query error:', err.message) })

    return () => { unsub1(); unsub2(); unsub3() }
  }, [profile])

  async function handleSendToAdmin(e) {
    e.preventDefault()
    if (!composeSubject.trim() || !composeMessage.trim()) return
    setComposeSending(true)
    setComposeStatus(null)
    try {
      await addDoc(collection(db, 'admin_messages'), {
        direction: 'from_student',
        sender_uid: profile.uid,
        sender_student_id: profile.student_id,
        sender_name: profile.name || 'Student',
        subject: sanitizeText(composeSubject),
        message: sanitizeText(composeMessage),
        recipient_id: 'admin',
        created_at: serverTimestamp()
      })
      setComposeStatus({ type: 'success', text: 'Message sent to administration.' })
      setComposeSubject('')
      setComposeMessage('')
      setTimeout(() => { setComposing(false); setComposeStatus(null) }, 2000)
    } catch (err) {
      console.error(err)
      setComposeStatus({ type: 'error', text: 'Unable to send message. Please try again.' })
    }
    setComposeSending(false)
  }

  async function handleReply(e) {
    e.preventDefault()
    if (!replyMessage.trim() || !selected) return
    setComposeSending(true)
    try {
      const reSubject = selected.subject.startsWith('Re: ') ? selected.subject : `Re: ${selected.subject}`
      await addDoc(collection(db, 'admin_messages'), {
        direction: 'from_student',
        sender_uid: profile.uid,
        sender_student_id: profile.student_id,
        sender_name: profile.name || 'Student',
        subject: sanitizeText(reSubject),
        message: sanitizeText(replyMessage),
        recipient_id: 'admin',
        created_at: serverTimestamp()
      })
      setReplyMessage('')
      setReplyOpen(false)
    } catch (err) {
      console.error(err)
    }
    setComposeSending(false)
  }

  async function handleDeleteMessage(msg) {
    setDeletingId(msg.id)
    if (sessionStorage.getItem('dev_user')) {
      const prev = JSON.parse(localStorage.getItem('lcspace_messages') || '[]')
      localStorage.setItem('lcspace_messages', JSON.stringify(prev.filter(m => m.id !== msg.id)))
      setMessages(ms => ms.filter(m => m.id !== msg.id))
      if (selected?.id === msg.id) setSelected(null)
      setDeletingId(null)
      return
    }
    // Broadcasts are shared docs — dismiss client-side only so other students aren't affected
    if (msg.recipient_id === 'all') {
      const dismissed = JSON.parse(localStorage.getItem('lcspace_dismissed_msgs') || '[]')
      localStorage.setItem('lcspace_dismissed_msgs', JSON.stringify([...new Set([...dismissed, msg.id])]))
      setMessages(ms => ms.filter(m => m.id !== msg.id))
      if (selected?.id === msg.id) setSelected(null)
      setDeletingId(null)
      return
    }
    // Addressed or student-sent messages — soft-delete so admin retains the record
    try {
      await updateDoc(doc(db, 'admin_messages', msg.id), {
        hidden_for_student: true,
        hidden_for_student_at: serverTimestamp(),
      })
      if (selected?.id === msg.id) setSelected(null)
    } catch (err) { console.error(err) }
    setDeletingId(null)
  }

  function fmt(ts) {
    if (!ts) return '—'
    const d = new Date(ts.seconds ? ts.seconds * 1000 : ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  const inboxMsgs = messages.filter(m => m.direction !== 'from_student')
  const sentMsgs = messages.filter(m => m.direction === 'from_student')
  const tabMsgs = activeTab === 'inbox' ? inboxMsgs : sentMsgs
  // Unread = direct messages addressed to me that I haven't opened yet.
  const unreadCount = inboxMsgs.filter(m => m.recipient_uid === profile?.uid && !m.read).length

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-transparent' : 'bg-white'}`}>
      {/* Header */}
      <div className={`px-8 py-4 border-b flex items-center justify-between flex-shrink-0 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {[['inbox', 'Inbox', unreadCount], ['sent', 'Sent', sentMsgs.length]].map(([tab, label, count]) => (
              <button key={tab} onClick={() => { setActiveTab(tab); setSelected(null); setComposing(false) }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${activeTab === tab ? 'bg-[#262367] text-white' : isDark ? 'text-white/50 hover:bg-white/10' : 'text-gray-500 hover:bg-gray-100'}`}>
                {label}
                {count > 0 && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${activeTab === tab ? 'bg-white/20 text-white' : isDark ? 'bg-white/10 text-white/60' : 'bg-gray-200 text-gray-600'}`}>{count}</span>}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => { setComposing(v => !v); setSelected(null) }}
          className="flex items-center gap-1.5 text-xs bg-[#262367] text-white border border-[#262367] rounded-lg px-3 py-1.5 hover:bg-[#35318c] transition font-semibold"
        >
          <Send size={12} /> New Message
        </button>
      </div>

      {/* Compose form */}
      {composing && (
        <div className="border-b border-gray-200 bg-gray-50 px-8 py-5 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Message Administration</h3>
          <form onSubmit={handleSendToAdmin} className="space-y-3">
            <label htmlFor="compose-subject" className="sr-only">Subject</label>
            <input
              id="compose-subject" name="subject" autoComplete="off"
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
              required
              placeholder="Subject"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition"
            />
            <label htmlFor="compose-body" className="sr-only">Message</label>
            <textarea
              id="compose-body" name="message" autoComplete="off"
              value={composeMessage}
              onChange={e => setComposeMessage(e.target.value)}
              required
              rows={4}
              placeholder="Write your message to administration..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition resize-none"
            />
            {composeStatus && (
              <p className={`text-xs ${composeStatus.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>{composeStatus.text}</p>
            )}
            <div className="flex items-center gap-2">
              <button type="submit" disabled={composeSending}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#262367] text-white rounded-lg text-xs font-semibold hover:bg-[#35318c] transition disabled:opacity-50">
                {composeSending ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send size={12} />}
                Send
              </button>
              <button type="button" onClick={() => { setComposing(false); setComposeSubject(''); setComposeMessage(''); setComposeStatus(null) }}
                className="px-4 py-2 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Two-pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* List */}
        <div className={`flex-shrink-0 border-r border-gray-200 overflow-y-auto ${selected ? 'w-80' : 'flex-1'}`}>
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-5 h-5 border-2 border-[#262367]/20 border-t-[#262367] rounded-full animate-spin" />
            </div>
          ) : tabMsgs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center px-8">
              <MailOpen className="w-9 h-9 text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">{activeTab === 'inbox' ? 'No messages yet' : 'No sent messages'}</p>
              <p className="text-xs text-gray-400 mt-1">{activeTab === 'inbox' ? 'Messages from administration will appear here.' : 'Messages you send to administration will appear here.'}</p>
            </div>
          ) : (
            <div className={`divide-y ${isDark ? 'divide-white/[0.06]' : 'divide-gray-100'}`}>
              {tabMsgs.map(msg => (
                <div
                  key={msg.id}
                  className={`group relative w-full px-6 py-4 transition cursor-pointer ${isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50'} ${selected?.id === msg.id ? isDark ? 'bg-white/5 border-l-2 border-[#262367]' : 'bg-blue-50/50 border-l-2 border-[#262367]' : 'border-l-2 border-transparent'}`}
                  onClick={() => {
                    const opening = selected?.id !== msg.id
                    setSelected(opening ? msg : null)
                    // Mark admin → student messages as read on open (visible to admin as "Seen")
                    if (opening && !msg.read && msg.direction !== 'from_student' && msg.recipient_uid === profile?.uid) {
                      updateDoc(doc(db, 'admin_messages', msg.id), { read: true, read_at: serverTimestamp() }).catch(() => { })
                    }
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${msg.direction === 'from_student' ? 'bg-green-50'
                      : msg.type === 'session_invite' ? 'bg-purple-50'
                        : msg.type === 'welcome' ? 'bg-[#F5C900]/20'
                          : 'bg-[#262367]/10'}`}>
                      {msg.type === 'session_invite'
                        ? <Monitor size={14} className="text-purple-600" />
                        : msg.type === 'welcome'
                          ? <Sparkles size={14} className="text-[#b8930a]" />
                          : msg.recipient_id === 'all'
                            ? <Megaphone size={14} className="text-[#262367]" />
                            : <Mail size={14} className={msg.direction === 'from_student' ? 'text-green-600' : 'text-[#262367]'} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className={`text-sm truncate flex items-center ${msg.direction !== 'from_student' && msg.recipient_uid === profile?.uid && !msg.read ? 'font-extrabold text-gray-900' : 'font-semibold text-gray-800'}`}>
                          {msg.direction !== 'from_student' && msg.recipient_uid === profile?.uid && !msg.read && (
                            <span className="inline-block w-2 h-2 rounded-full bg-[#262367] mr-1.5 flex-shrink-0" />
                          )}
                          {msg.subject}
                        </span>
                        <span className="text-[11px] text-gray-400 flex-shrink-0">{fmt(msg.created_at)}</span>
                      </div>
                      <p className="text-xs text-gray-500 truncate leading-snug">{msg.message}</p>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        {msg.recipient_id === 'all' && (
                          <span className="inline-flex text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">Broadcast</span>
                        )}
                        {msg.direction === 'from_student' && (
                          msg.read
                            ? <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600"><CheckCircle2 size={11} /> Seen by admin</span>
                            : !msg.created_at?.seconds
                              ? <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-400"><Check size={11} /> Sent</span>
                              : <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-500"><Check size={11} /> Delivered</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteMessage(msg) }}
                      disabled={deletingId === msg.id}
                      className="opacity-0 group-hover:opacity-100 transition flex-shrink-0 mt-0.5 p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 disabled:opacity-50"
                    >
                      {deletingId === msg.id
                        ? <div className="w-3.5 h-3.5 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" />
                        : <Trash2 size={13} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail pane */}
        {selected && (
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-2xl">
              <div className="flex items-start justify-between mb-5">
                <div className="flex-1 min-w-0 pr-4">
                  <h3 className="text-lg font-semibold text-gray-900">{selected.subject}</h3>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-gray-500">
                    {selected.direction === 'from_student'
                      ? <span>To: <span className="font-medium text-gray-700">Administration</span></span>
                      : <span>From: <span className="font-medium text-gray-700">Administration</span></span>
                    }
                    <span className="text-gray-300">·</span>
                    <span>{selected.created_at ? new Date(selected.created_at.seconds ? selected.created_at.seconds * 1000 : selected.created_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</span>
                  </div>
                  {selected.direction !== 'from_student' && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-gray-400">To:</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${selected.recipient_id === 'all' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
                        {selected.recipient_id === 'all' ? 'All Students' : 'You'}
                      </span>
                      {selected.type === 'password_reset' && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 flex items-center gap-1">
                          <Lock size={10} /> Security
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {selected.direction !== 'from_student' && (
                    <button
                      onClick={() => { setReplyOpen(v => !v); setReplyMessage('') }}
                      className="text-xs text-[#262367] hover:text-white hover:bg-[#262367] border border-[#262367]/30 hover:border-[#262367] rounded-lg px-3 py-1.5 transition flex items-center gap-1.5 font-medium"
                    >
                      <Send size={11} /> Reply
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteMessage(selected)}
                    disabled={deletingId === selected?.id}
                    className="text-xs text-red-500 hover:text-red-700 border border-red-200 hover:bg-red-50 rounded-lg px-3 py-1.5 transition flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {deletingId === selected?.id
                      ? <div className="w-3 h-3 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" />
                      : <Trash2 size={12} />}
                    Delete
                  </button>
                  <button onClick={() => { setSelected(null); setReplyOpen(false); setReplyMessage('') }} className="text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 transition">
                    Close
                  </button>
                </div>
              </div>
              {/* Welcome message hero banner */}
              {selected.type === 'welcome' && (
                <div className="mb-4 bg-[#262367] rounded-xl p-5 flex items-center gap-4 relative overflow-hidden">
                  <div className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'radial-gradient(circle at 80% 50%, white 0%, transparent 60%)' }} />
                  <div className="w-10 h-10 rounded-xl bg-[#F5C900]/20 flex items-center justify-center flex-shrink-0 relative">
                    <Sparkles size={20} className="text-[#F5C900]" />
                  </div>
                  <div className="relative">
                    <p className="text-sm font-bold text-white leading-tight">Welcome to LCspace</p>
                    <p className="text-xs text-white/60 mt-0.5">Your account is under review. Check this message for everything you need to get started.</p>
                  </div>
                </div>
              )}

              <div className="bg-gray-50 border border-gray-200 rounded-xl p-5">
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed break-all">{selected.message}</p>
              </div>

              {/* Join Session CTA for invite messages */}
              {selected.type === 'session_invite' && selected.session_id && (
                <div className="mt-4 bg-[#262367]/5 border border-[#262367]/20 rounded-xl p-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-[#262367]/10 flex items-center justify-center flex-shrink-0">
                    <Monitor size={18} className="text-[#262367]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{selected.session_room}</p>
                    <p className="text-xs text-gray-500">{selected.session_time}</p>
                  </div>
                  <button
                    onClick={() => navigate(`/session?invite=${selected.session_id}`)}
                    className="flex items-center gap-1.5 px-4 py-2 bg-[#262367] text-white rounded-lg text-sm font-semibold hover:bg-[#35318c] transition flex-shrink-0"
                  >
                    <Monitor size={13} /> Join Session
                  </button>
                </div>
              )}

              {/* Inline reply form */}
              {replyOpen && selected.direction !== 'from_student' && (
                <form onSubmit={handleReply} className="mt-4 bg-white border border-[#262367]/20 rounded-xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-gray-700">
                    Re: <span className="font-normal text-gray-500">{selected.subject}</span>
                  </p>
                  <label htmlFor="reply-body" className="sr-only">Reply</label>
                  <textarea
                    id="reply-body" name="reply" autoComplete="off"
                    value={replyMessage}
                    onChange={e => setReplyMessage(e.target.value)}
                    required
                    rows={4}
                    placeholder="Write your reply..."
                    autoFocus
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <button type="submit" disabled={composeSending}
                      className="flex items-center gap-1.5 px-4 py-2 bg-[#262367] text-white rounded-lg text-xs font-semibold hover:bg-[#35318c] transition disabled:opacity-50">
                      {composeSending ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send size={12} />}
                      Send Reply
                    </button>
                    <button type="button" onClick={() => { setReplyOpen(false); setReplyMessage('') }}
                      className="px-4 py-2 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition">
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StudentHelp({ profile }) {
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState(null)
  const [tickets, setTickets] = useState([])
  const [loadingTickets, setLoadingTickets] = useState(true)
  const [deletingTicketId, setDeletingTicketId] = useState(null)

  useEffect(() => {
    if (!profile || !profile.student_id) { setLoadingTickets(false); return }
    if (sessionStorage.getItem('dev_user')) {
      const prev = JSON.parse(localStorage.getItem('lcspace_help_tickets') || '[]')
      setTickets(prev.filter(t => t.student_id === profile.student_id))
      setLoadingTickets(false)
      return
    }
    const q = query(collection(db, 'help_tickets'), where('student_id', '==', profile.student_id))
    const unsub = onSnapshot(q, snap => {
      const fetched = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      fetched.sort((a, b) => {
        const ta = a.created_at?.seconds ? a.created_at.seconds * 1000 : new Date(a.created_at || 0).getTime()
        const tb = b.created_at?.seconds ? b.created_at.seconds * 1000 : new Date(b.created_at || 0).getTime()
        return tb - ta
      })
      setTickets(fetched)
      setLoadingTickets(false)
    }, err => { console.warn('Help tickets error:', err.message); setLoadingTickets(false) })
    return unsub
  }, [profile])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!subject.trim() || !message.trim()) return

    const rl = checkRateLimit('helpticket')
    if (!rl.allowed) {
      setStatus({ type: 'error', text: `Too many submissions. Please wait ${formatRetryAfter(rl.retryAfterMs)} before trying again.` })
      return
    }

    setSending(true)
    setStatus(null)
    if (sessionStorage.getItem('dev_user')) {
      const prev = JSON.parse(localStorage.getItem('lcspace_help_tickets') || '[]')
      const newTicket = {
        id: genId('TKT'),
        student_id: profile?.student_id || 'unknown',
        student_name: profile?.name || 'Unknown Student',
        email: profile?.email || '',
        subject: subject.trim(),
        message: message.trim(),
        status: 'open',
        created_at: new Date().toISOString()
      }
      localStorage.setItem('lcspace_help_tickets', JSON.stringify([newTicket, ...prev]))
      setTickets([newTicket, ...tickets])
      setStatus({ type: 'success', text: 'Ticket submitted successfully.' })
      setSubject('')
      setMessage('')
      setSending(false)
      setTimeout(() => setStatus(null), 5000)
      return
    }
    try {
      const cleanSubject = sanitizeText(subject)
      const cleanMessage = sanitizeText(message)
      await setDoc(doc(collection(db, 'help_tickets')), {
        student_id: profile?.student_id || 'unknown',
        student_name: profile?.name || 'Unknown Student',
        email: profile?.email || '',
        subject: cleanSubject,
        message: cleanMessage,
        status: 'open',
        created_at: serverTimestamp()
      })
      setStatus({ type: 'success', text: 'Ticket submitted successfully.' })
      setSubject('')
      setMessage('')
    } catch (err) {
      setStatus({ type: 'error', text: 'Unable to submit ticket. Please try again.' })
    }
    setSending(false)
    setTimeout(() => { if (status?.type === 'success') setStatus(null) }, 5000)
  }

  async function handleDeleteTicket(ticket) {
    setDeletingTicketId(ticket.id)
    if (sessionStorage.getItem('dev_user')) {
      const prev = JSON.parse(localStorage.getItem('lcspace_help_tickets') || '[]')
      localStorage.setItem('lcspace_help_tickets', JSON.stringify(prev.filter(t => t.id !== ticket.id)))
      setTickets(ts => ts.filter(t => t.id !== ticket.id))
      setDeletingTicketId(null)
      return
    }
    try {
      await deleteDoc(doc(db, 'help_tickets', ticket.id))
    } catch (err) { console.error(err) }
    setDeletingTicketId(null)
  }

  function fmt(ts) {
    if (!ts) return '—'
    return new Date(ts.seconds ? ts.seconds * 1000 : ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900">Help & Support</h2>
          <p className="text-xs text-gray-400 mt-0.5">Submit a request and our team will respond as soon as possible.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Submit form */}
          <div className="lg:col-span-2">
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">New Request</h3>
              </div>
              <div className="p-5">
                {status && (
                  <div className={`mb-4 flex items-center gap-2 p-3 rounded-lg text-sm border ${status.type === 'success' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                    {status.type === 'success' ? <CheckCircle2 size={14} className="flex-shrink-0" /> : <AlertTriangle size={14} className="flex-shrink-0" />}
                    {status.text}
                  </div>
                )}
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="ticket-subject" className="block text-xs font-medium text-gray-700 mb-1.5">Subject</label>
                    <input
                      id="ticket-subject" name="subject" autoComplete="off"
                      type="text"
                      value={subject}
                      onChange={e => setSubject(e.target.value)}
                      placeholder="e.g., Booking issue, Room access"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition placeholder-gray-400"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="ticket-description" className="block text-xs font-medium text-gray-700 mb-1.5">Description</label>
                    <textarea
                      id="ticket-description" name="description" autoComplete="off"
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      placeholder="Describe your issue in detail..."
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition placeholder-gray-400 resize-none min-h-[120px]"
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={sending || !subject.trim() || !message.trim()}
                    className="w-full flex items-center justify-center gap-2 bg-[#262367] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#35318c] transition disabled:opacity-50"
                  >
                    {sending
                      ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      : <><Send size={13} /> Submit Request</>
                    }
                  </button>
                </form>
              </div>
            </div>
            <div className="mt-3 flex items-start gap-2 p-3.5 bg-gray-50 border border-gray-200 rounded-xl">
              <AlertCircle size={13} className="text-gray-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-gray-500 leading-relaxed">For urgent access issues, contact the on-duty admin at the LCspace counter directly.</p>
            </div>
          </div>

          {/* Ticket history */}
          <div className="lg:col-span-3">
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">My Tickets</h3>
                <span className="text-xs text-gray-400">{tickets.length} total</span>
              </div>
              {loadingTickets ? (
                <div className="flex items-center justify-center h-40">
                  <div className="w-5 h-5 border-2 border-[#262367]/20 border-t-[#262367] rounded-full animate-spin" />
                </div>
              ) : tickets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-14 text-center px-6">
                  <CheckCircle2 className="w-9 h-9 text-gray-300 mb-3" />
                  <p className="text-sm font-medium text-gray-600">No tickets yet</p>
                  <p className="text-xs text-gray-400 mt-1">Use the form to submit your first request.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {tickets.map(t => (
                    <div key={t.id} className="group px-5 py-4">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <span className="text-sm font-medium text-gray-900 leading-snug">{t.subject}</span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${t.status === 'Resolved'
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}>
                            {t.status === 'Resolved' ? 'Resolved' : 'Open'}
                          </span>
                          <button
                            onClick={() => handleDeleteTicket(t)}
                            disabled={deletingTicketId === t.id}
                            className="opacity-0 group-hover:opacity-100 transition p-1 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 disabled:opacity-50"
                          >
                            {deletingTicketId === t.id
                              ? <div className="w-3.5 h-3.5 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" />
                              : <Trash2 size={13} />}
                          </button>
                        </div>
                      </div>
                      <p className="text-xs text-gray-500 mb-2.5 line-clamp-2 leading-relaxed">{t.message}</p>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-400">{fmt(t.created_at)}</span>
                        <span className="text-[11px] text-gray-400 font-mono">#{t.id.substring(0, 8)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// BOOKING CALENDAR
// ─────────────────────────────────────────────────────────────

function BookingCalendar({ bookings, setView }) {
  const today = new Date()
  const [current, setCurrent] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState(null)

  const year = current.getFullYear()
  const month = current.getMonth()

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

  function prevMonth() { setCurrent(new Date(year, month - 1, 1)); setSelected(null) }
  function nextMonth() { setCurrent(new Date(year, month + 1, 1)); setSelected(null) }

  // Map bookings to YYYY-MM-DD key
  const bookingsByDate = useMemo(() => {
    const map = {}
    bookings.forEach(b => {
      const key = b.booking_date || (b.date ? new Date(b.date).toISOString().split('T')[0] : null)
      if (!key) return
      if (!map[key]) map[key] = []
      map[key].push(b)
    })
    return map
  }, [bookings])

  // Build grid cells
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  function dateKey(d) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  function isToday(d) {
    return d === today.getDate() && month === today.getMonth() && year === today.getFullYear()
  }

  const statusDot = {
    Confirmed: 'bg-blue-400',
    'Checked-In': 'bg-emerald-400',
    Active: 'bg-emerald-400',
    Pending: 'bg-amber-400',
    Cancelled: 'bg-gray-300',
    'No-Show': 'bg-orange-400',
  }

  const selectedBookings = selected ? (bookingsByDate[dateKey(selected)] || []) : []

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-gray-900">My Calendar</h2>
        <p className="text-xs text-gray-400 mt-0.5">View all your reservations by date.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Calendar grid */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-5">
            <button onClick={prevMonth} className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition">
              <ChevronRight size={15} className="text-gray-600 rotate-180" />
            </button>
            <h3 className="text-sm font-bold text-gray-900">{MONTHS[month]} {year}</h3>
            <button onClick={nextMonth} className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition">
              <ChevronRight size={15} className="text-gray-600" />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 mb-2">
            {DAYS.map(d => (
              <div key={d} className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider py-1">{d}</div>
            ))}
          </div>

          {/* Cells */}
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              if (!d) return <div key={`e-${i}`} />
              const key = dateKey(d)
              const dayBookings = bookingsByDate[key] || []
              const isSelected = selected === d
              const todayCell = isToday(d)
              const hasBooking = dayBookings.length > 0

              return (
                <button
                  key={key}
                  onClick={() => setSelected(isSelected ? null : d)}
                  className={`relative flex flex-col items-center justify-start pt-1.5 pb-2 rounded-xl min-h-[52px] transition-all
                    ${isSelected ? 'bg-[#262367] text-white shadow-md' : todayCell ? 'bg-[#262367]/10 text-[#262367] font-bold' : 'hover:bg-gray-50 text-gray-700'}
                  `}
                >
                  <span className={`text-xs font-semibold leading-none ${isSelected ? 'text-white' : todayCell ? 'text-[#262367]' : 'text-gray-700'}`}>{d}</span>
                  {hasBooking && (
                    <div className="flex gap-0.5 flex-wrap justify-center mt-1.5 px-1">
                      {dayBookings.slice(0, 3).map((b, idx) => (
                        <span key={idx} className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isSelected ? 'bg-white/70' : statusDot[b.status] || 'bg-gray-300'}`} />
                      ))}
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          {/* Legend */}
          <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-3">
            {[['Pending', 'bg-amber-400'], ['Confirmed', 'bg-blue-400'], ['Checked-In', 'bg-emerald-400'], ['Cancelled', 'bg-gray-300'], ['No-Show', 'bg-orange-400']].map(([label, cls]) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${cls}`} />
                <span className="text-[10px] text-gray-500">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Day detail */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">
              {selected
                ? `${MONTHS[month]} ${selected}, ${year}`
                : 'Select a day'}
            </h3>
          </div>
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
              <CalendarDays size={32} className="text-gray-200 mb-3" />
              <p className="text-sm text-gray-400">Click a date to view bookings for that day.</p>
            </div>
          ) : selectedBookings.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
              <CalendarDays size={32} className="text-gray-200 mb-3" />
              <p className="text-sm font-medium text-gray-500">No bookings</p>
              <p className="text-xs text-gray-400 mt-1">You have no reservations on this date.</p>
              <button
                onClick={() => setView('reserve')}
                className="mt-4 px-4 py-2 rounded-xl bg-[#262367] text-white text-xs font-semibold hover:bg-[#35318c] transition"
              >
                Reserve a Slot
              </button>
            </div>
          ) : (
            <div className="flex-1 overflow-auto divide-y divide-gray-100">
              {selectedBookings.map(b => (
                <div key={b.id || b.firestoreId} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-sm font-semibold text-gray-900 leading-tight">{b.room_name || b.facility}</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg flex-shrink-0 ${STATUS_STYLES[b.status] || 'bg-gray-100 text-gray-500'}`}>
                      {b.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Clock size={11} />
                    <span>{b.time}</span>
                  </div>
                  {b.purpose && (
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">{b.purpose}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// GUIDE & RULES
// ─────────────────────────────────────────────────────────────

function GuideAndRules() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [openSection, setOpenSection] = useState(null)

  function toggle(key) { setOpenSection(p => p === key ? null : key) }

  const facilities = [
    {
      name: 'Collaborative Room 1 & 2',
      icon: <Users size={18} className="text-[#262367]" />,
      capacity: '4 – 6 people',
      features: ['Interactive whiteboard', 'Power outlets at every seat', 'High-speed WiFi'],
      note: 'Ideal for group study sessions, small team meetings, and collaborative projects.',
    },
    {
      name: "Innovative Makers' Space 1 & 2",
      icon: <Wrench size={18} className="text-[#262367]" />,
      capacity: '6 – 8 people',
      features: ['Large interactive whiteboard', 'Equipment & maker tools', 'Power outlets', 'High-speed WiFi', 'Air-conditioned'],
      note: 'Best for hands-on projects, prototyping, and design-thinking workshops.',
    },
  ]

  const timeSlots = [
    { slot: '8:00 AM – 10:00 AM', label: 'Morning 1' },
    { slot: '10:00 AM – 12:00 PM', label: 'Morning 2' },
    { slot: '12:00 PM – 2:00 PM', label: 'Afternoon 1' },
    { slot: '2:00 PM – 4:00 PM', label: 'Afternoon 2' },
  ]

  const faqItems = [
    {
      q: 'How do I make a reservation?',
      a: 'Go to "Reserve Facility" from the sidebar. Choose your room, date, time slot, and purpose, then submit. Your booking will be marked Pending until an admin reviews and confirms it.',
    },
    {
      q: 'How many reservations can I make per day?',
      a: 'Only one reservation per student per day. The system will block any second reservation on the same date — cancel the first one (if still Pending) before booking another, or wait until the next day.',
    },
    {
      q: 'Can I cancel my booking?',
      a: 'Cancellation is available only while the booking is Pending and only within 15 minutes of creating it. Once it is Confirmed (or once the 15-minute window passes), you must contact the LCspace admin desk to cancel.',
    },
    {
      q: 'Can I delete a booking from my list?',
      a: 'You can remove Confirmed, Checked-In, or Cancelled bookings from your personal list — but the record is still retained by the admin. Pending bookings cannot be deleted from your list (you may still cancel them within 15 minutes).',
    },
    {
      q: 'What is the Check-In requirement?',
      a: 'Once your booking is Confirmed, you must visit the LCspace admin desk in person so staff can mark you as Checked-In. Only after check-in can you enter Cyberspace for your session.',
    },
    {
      q: 'What is Cyberspace and how does it work?',
      a: 'Cyberspace is LCspace\'s real-time digital learning hub — a virtual room with video conferencing, a shared whiteboard, group chat, and screen sharing. To enter, you need a Confirmed booking for today, you must be Checked-In at the admin desk, and you must be within your reserved time window. The admin will give you a unique personal access code at the desk — enter that code in the Cyberspace modal to join the session. Sessions automatically close when your reserved time ends.',
    },
    {
      q: 'What happens if I don\'t show up?',
      a: 'Repeated no-shows result in a strike on your account. Three strikes will restrict your booking privileges. Please cancel in advance if you cannot attend.',
    },
    {
      q: 'Can I invite others to my Cyberspace session?',
      a: 'Yes — once you are in a Cyberspace session, use the Invite panel to add other LCspace-registered students by their Student ID. Invited guests bypass the booking requirement but are bound by the same time window.',
    },
  ]

  const AccordionItem = ({ itemKey, title, icon, children }) => {
    const open = openSection === itemKey
    return (
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <button
          onClick={() => toggle(itemKey)}
          className="w-full flex items-center gap-3 px-5 py-4 text-left bg-white hover:bg-gray-50 transition"
        >
          <div className="w-8 h-8 rounded-lg bg-[#262367]/8 flex items-center justify-center flex-shrink-0">
            {icon}
          </div>
          <span className="flex-1 text-sm font-semibold text-gray-900">{title}</span>
          {open ? <ChevronUp size={15} className="text-gray-400 flex-shrink-0" /> : <ChevronDown size={15} className="text-gray-400 flex-shrink-0" />}
        </button>
        {open && (
          <div className="px-5 pb-5 bg-white border-t border-gray-100">
            {children}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h2 className={`text-2xl font-extrabold ${isDark ? 'text-white' : 'text-[#262367]'}`}>Guide &amp; Rules</h2>
        <p className={`text-sm mt-1 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>Everything you need to know about using LCspace facilities.</p>
      </div>

      <div className="space-y-4">
        {/* Available Facilities */}
        <AccordionItem itemKey="facilities" title="Available Facilities" icon={<Building2 size={15} className="text-[#262367]" />}>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {facilities.map(f => (
              <div key={f.name} className="border border-gray-100 rounded-xl p-4 bg-gray-50">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-lg bg-[#262367]/10 flex items-center justify-center">{f.icon}</div>
                  <p className="text-sm font-bold text-gray-900">{f.name}</p>
                </div>
                <p className="text-xs text-gray-500 mb-3">{f.note}</p>
                <div className="flex items-center gap-1.5 mb-2">
                  <Users size={11} className="text-gray-400" />
                  <span className="text-xs font-semibold text-gray-600">Capacity: {f.capacity}</span>
                </div>
                <ul className="space-y-1">
                  {f.features.map(feat => (
                    <li key={feat} className="flex items-center gap-1.5 text-xs text-gray-500">
                      <CheckCircle2 size={11} className="text-emerald-400 flex-shrink-0" />
                      {feat}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </AccordionItem>

        {/* Time Slots */}
        <AccordionItem itemKey="timeslots" title="Available Time Slots" icon={<Clock size={15} className="text-[#262367]" />}>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {timeSlots.map(({ slot, label }) => (
              <div key={slot} className="bg-[#262367]/5 border border-[#262367]/10 rounded-xl p-3 text-center">
                <p className="text-[10px] font-bold text-[#262367] uppercase tracking-wider mb-1">{label}</p>
                <p className="text-xs font-semibold text-gray-700 leading-snug">{slot.replace('–', '–\n')}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">Each time slot is exactly 2 hours. Sessions cannot be extended beyond the reserved window.</p>
        </AccordionItem>

        {/* Booking Process */}
        <AccordionItem itemKey="booking" title="How to Book a Facility" icon={<CalendarDays size={15} className="text-[#262367]" />}>
          <ol className="mt-4 space-y-4">
            {[
              { n: '1', title: 'Reserve a Slot', desc: 'Go to "Reserve Facility", pick a room, date, time slot, and enter your purpose and group size. Only one reservation per student per day is allowed.' },
              { n: '2', title: 'Wait for Admin Confirmation', desc: 'Your booking starts as Pending. An admin will review and confirm or decline your request. You may cancel within 15 minutes while still Pending — after that, only the admin can cancel.' },
              { n: '3', title: 'Check In at the Desk', desc: 'Once Confirmed, visit the LCspace admin desk in person. Staff will mark you as Checked-In and hand you a personal Cyberspace access code.' },
              { n: '4', title: 'Access Cyberspace', desc: 'After check-in, the Cyberspace button unlocks during your reserved time window. Enter your access code to join the session.' },
              { n: '5', title: 'Session Ends Automatically', desc: 'Access closes at the end of your reserved slot. Please save your work and log off before the session expires.' },
            ].map(({ n, title, desc }) => (
              <li key={n} className="flex gap-4">
                <div className="w-7 h-7 rounded-full bg-[#262367] text-white text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{n}</div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{title}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </AccordionItem>

        {/* Cyberspace */}
        <AccordionItem itemKey="cyberspace" title="What is Cyberspace?" icon={<Monitor size={15} className="text-[#262367]" />}>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-gray-600 leading-relaxed">
              <span className="font-bold text-[#262367]">Cyberspace</span> is LCspace's real-time digital learning hub — a virtual room that pairs with your physical reservation. It includes:
            </p>
            <ul className="space-y-2">
              {[
                { Icon: Users, text: 'Live video conferencing with everyone in your booking' },
                { Icon: PenLine, text: 'Shared digital whiteboard with multi-user drawing' },
                { Icon: MessageSquare, text: 'Group chat for links, notes, and quick coordination' },
                { Icon: ScreenShare, text: 'Screen sharing for presentations and tutorials' },
                { Icon: UserPlus, text: 'Invite other LCspace-registered students by their Student ID during the session' },
              ].map(({ Icon, text }, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <div className="w-7 h-7 rounded-lg bg-[#262367]/10 flex items-center justify-center flex-shrink-0">
                    <Icon size={13} className="text-[#262367]" />
                  </div>
                  <span className="text-sm text-gray-700 leading-relaxed mt-0.5">{text}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 bg-[#262367]/5 border border-[#262367]/15 rounded-xl p-4">
              <p className="text-xs font-bold text-[#262367] uppercase tracking-wider mb-3">How to access Cyberspace</p>
              <ol className="space-y-3">
                {[
                  'Have a Confirmed booking for today (Pending bookings don\'t qualify).',
                  'Visit the LCspace admin desk and have staff mark you as Checked-In.',
                  'Ask the admin for your personal Access Code — each booking has a unique code.',
                  'Open the Cyberspace tab (or the Cyberspace button on your booking) and enter the code.',
                  'You\'re in. Camera, microphone, whiteboard, and chat are all available for the duration of your slot.',
                ].map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <div className="w-6 h-6 rounded-full bg-[#262367] text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0">{i + 1}</div>
                    <p className="text-sm text-gray-700 leading-relaxed">{step}</p>
                  </li>
                ))}
              </ol>
            </div>

            <p className="text-xs text-gray-500 leading-relaxed">
              <span className="font-semibold">Time limits:</span> Access opens at the start of your reserved slot and closes automatically when the slot ends. If you try to enter before your slot or after it has ended, you'll see a message explaining why access is locked.
            </p>
          </div>
        </AccordionItem>

        {/* House Rules */}
        <AccordionItem itemKey="rules" title="House Rules & Code of Conduct" icon={<ShieldCheck size={15} className="text-[#262367]" />}>
          <div className="mt-4 space-y-3">
            {[
              'Bookings are for the registered student only. Do not share your login credentials.',
              'Arrive on time. Your time slot is fixed and cannot be extended regardless of late arrival.',
              'The facility must be left clean and orderly after every session. Return all equipment to its original position.',
              'Keep noise levels appropriate for an academic environment. Be considerate of other users.',
              'Food and drinks with strong odors are not allowed inside the rooms.',
              'Any damage to equipment or furniture must be reported immediately to the admin desk.',
              'Recording or streaming within LCspace sessions must be done with the consent of all present.',
              'Misuse of Cyberspace tools (e.g., inappropriate content, harassment) will result in an immediate strike and account review.',
              'Bookings made for others (proxy reservations) are strictly prohibited.',
            ].map((rule, i) => (
              <div key={i} className="flex gap-3">
                <ShieldCheck size={13} className="text-[#262367] flex-shrink-0 mt-0.5" />
                <p className="text-sm text-gray-700 leading-relaxed">{rule}</p>
              </div>
            ))}
          </div>
        </AccordionItem>

        {/* Strike System */}
        <AccordionItem itemKey="strikes" title="Strike System" icon={<AlertOctagon size={15} className="text-[#262367]" />}>
          <div className="mt-4 space-y-3">
            <p className="text-sm text-gray-600 leading-relaxed">
              LCspace uses a three-strike system to ensure fair access for all students. Strikes are issued for:
            </p>
            <ul className="space-y-2 mt-2">
              {[
                'No-show on a confirmed booking without prior cancellation',
                'Leaving the facility in poor condition (equipment damage, trash, etc.)',
                'Violation of the Code of Conduct during a session',
                'Proxy booking or account sharing',
              ].map((item, i) => (
                <li key={i} className="flex gap-2.5 items-start">
                  <AlertTriangle size={12} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-gray-700">{item}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { count: '1 Strike', desc: 'Formal warning issued to your account.', color: 'border-amber-200 bg-amber-50' },
                { count: '2 Strikes', desc: 'Booking privileges temporarily limited.', color: 'border-orange-200 bg-orange-50' },
                { count: '3 Strikes', desc: 'Account suspended — admin review required.', color: 'border-red-200 bg-red-50' },
              ].map(({ count, desc, color }) => (
                <div key={count} className={`border rounded-xl p-3 text-center ${color}`}>
                  <p className="text-xs font-bold text-gray-900 mb-1">{count}</p>
                  <p className="text-[11px] text-gray-600 leading-snug">{desc}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">Strikes may be appealed by submitting a Help ticket. Decisions are made by the LCspace administration.</p>
          </div>
        </AccordionItem>

        {/* FAQ */}
        <AccordionItem itemKey="faq" title="Frequently Asked Questions" icon={<Info size={15} className="text-[#262367]" />}>
          <div className="mt-4 space-y-4">
            {faqItems.map(({ q, a }) => (
              <div key={q} className="pb-4 border-b border-gray-100 last:border-0 last:pb-0">
                <p className="text-sm font-semibold text-gray-900 mb-1">{q}</p>
                <p className="text-sm text-gray-500 leading-relaxed">{a}</p>
              </div>
            ))}
          </div>
        </AccordionItem>

        {/* Contact */}
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-5 flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-[#262367]/10 flex items-center justify-center flex-shrink-0">
            <HelpCircle size={18} className="text-[#262367]" />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">Need more help?</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              Visit the LCspace admin desk during operating hours, or use the <strong>Help &amp; Support</strong> tab to submit a ticket and our team will respond as soon as possible.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
