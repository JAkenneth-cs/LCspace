import { useState, useEffect, useMemo, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, onSnapshot, doc, getDoc, updateDoc, addDoc, setDoc, deleteDoc, getDocs, query, orderBy, where, limit, serverTimestamp, increment, deleteField } from 'firebase/firestore'
import { sendPasswordResetEmail, signOut, onAuthStateChanged } from 'firebase/auth'
import { adminDb as db, adminAuth as auth } from '../lib/firebase'
import {
  Shield, Clock, CheckCircle2, Users, Building2, LogOut,
  Search, Upload, UserPlus, Monitor, BookOpen, RotateCcw,
  Trash2, Activity, AlertCircle, ChevronRight, FileText,
  Mic, Camera, ScreenShare, PhoneOff, Wrench, Megaphone, Settings, Check, Lock, Key,
  Mail, MailOpen, HelpCircle, Send, Eye, EyeOff, Folder, X, UserX, UserCheck,
  BarChart2, TrendingUp, TrendingDown, ArrowUpRight, Users2, GraduationCap, CalendarCheck, Scale, Archive, Zap
} from 'lucide-react'
import LoadingScreen from '../components/LoadingScreen'
import AlertModal from '../components/AlertModal'
import { sanitizeText } from '../lib/validation'
import { sha256, genId } from '../lib/crypto'

const STATUS_STYLES = {
  Confirmed: 'bg-blue-50 text-blue-700',
  'Checked-In': 'bg-green-50 text-green-700',
  Active: 'bg-green-50 text-green-700',
  Done: 'bg-emerald-100 text-emerald-700',
  Cancelled: 'bg-gray-100 text-gray-500',
  'No-Show': 'bg-orange-50 text-orange-700',
  Pending: 'bg-yellow-50 text-yellow-700',
}

const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Parse '8:00 AM – 10:00 AM' into { startMs, endMs } for a given booking date
function parseSlot(timeStr, isoDate) {
  if (!timeStr || !isoDate) return null
  const parts = timeStr.replace(/–|—|‒/g, '-').split('-').map(s => s.trim())
  if (parts.length < 2) return null
  const toMs = (str) => {
    const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i)
    if (!m) return null
    let h = parseInt(m[1], 10); const min = parseInt(m[2], 10)
    const period = m[3].toUpperCase()
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    // Use manual parsing to avoid timezone shifts
    const [y, mon, dd] = isoDate.split('-').map(Number)
    const d = new Date(y, mon - 1, dd)
    d.setHours(h, min, 0, 0)
    return d.getTime()
  }
  const startMs = toMs(parts[0]); const endMs = toMs(parts[1])
  if (!startMs || !endMs) return null
  return { startMs, endMs }
}

export default function Admin() {
  const navigate = useNavigate()
  const [view, setView] = useState('command')
  const [bookings, setBookings] = useState([])
  const [adminProfile, setAdminProfile] = useState(() => JSON.parse(sessionStorage.getItem('admin_user') || '{}'))
  const [alertConfig, setAlertConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [bookingsError, setBookingsError] = useState(null)

  useEffect(() => {
    if (!sessionStorage.getItem('admin_user')) {
      navigate('/admin-login')
      return
    }
    // Real-time Firestore listener — updates the table whenever a booking changes.
    // Listen to the whole collection (no orderBy → no field/index dependency) and
    // sort newest-first on the client so every booking always appears.
    let unsubBookings = null
    const attach = () => {
      if (unsubBookings) { unsubBookings(); unsubBookings = null }
      unsubBookings = onSnapshot(collection(db, 'bookings'), snap => {
        const rows = snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }))
        rows.sort((a, b) => {
          const ta = a.created_at?.seconds ? a.created_at.seconds * 1000 : new Date(a.created_at || 0).getTime()
          const tb = b.created_at?.seconds ? b.created_at.seconds * 1000 : new Date(b.created_at || 0).getTime()
          return tb - ta
        })
        setBookings(rows)
        setBookingsError(null)
        setLoading(false)
      }, err => {
        console.warn('Bookings listener error:', err.code, err.message)
        setBookingsError(err.code || err.message)
        setBookings(JSON.parse(localStorage.getItem('lcspace_bookings_v1') || '[]'))
        setLoading(false)
      })
    }

    // Attach immediately (covers a warm session); also react to admin auth state.
    attach()
    const unsubAuth = onAuthStateChanged(auth, user => {
      if (user) {
        // Auth confirmed/restored — (re)attach so reads are permitted.
        attach()
      } else {
        // The admin UI was reached with a stale sessionStorage entry but NO live
        // Firebase session, so every Firestore read is denied. Force a real re-login.
        sessionStorage.removeItem('admin_user')
        navigate('/admin-login')
      }
    })

    return () => { if (unsubBookings) unsubBookings(); unsubAuth() }
  }, [navigate])

  async function updateStatus(firestoreId, newStatus) {
    try {
      const payload = { status: newStatus }
      if (newStatus === 'Done') payload.done_at = serverTimestamp()
      await updateDoc(doc(db, 'bookings', firestoreId), payload)
    } catch (err) {
      console.error('Status update failed:', err.message)
    }
  }

  // Auto-mark sessions as Done once their reserved time has fully passed
  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      bookings.forEach(b => {
        if (b.status !== 'Confirmed' && b.status !== 'Checked-In' && b.status !== 'Active') return
        const slot = parseSlot(b.time, b.booking_date)
        if (slot && now > slot.endMs && b.firestoreId) {
          updateDoc(doc(db, 'bookings', b.firestoreId), {
            status: 'Done',
            done_at: serverTimestamp(),
            auto_done: true,
          }).catch(() => { })
        }
      })
    }
    tick()
    const t = setInterval(tick, 60 * 1000) // re-check every minute
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings])

  function markNoShow(booking) {
    const studentName = booking.student_name || booking.name || 'this student'
    setAlertConfig({
      type: 'confirm',
      title: 'Mark as No-Show',
      message: `Mark ${studentName}'s booking (${booking.id}) as No-Show? This will add 1 strike to their account. At 3 strikes their account is suspended.`,
      confirmLabel: 'Mark No-Show',
      danger: true,
      onConfirm: async () => {
        try {
          // Mark booking as No-Show
          await updateDoc(doc(db, 'bookings', booking.firestoreId), { status: 'No-Show' })

          // Find the student's user doc by user_id or student_id
          let userDocId = booking.user_id || null
          if (!userDocId) {
            const snap = await getDocs(query(collection(db, 'users'), where('student_id', '==', booking.student_id)))
            if (!snap.empty) userDocId = snap.docs[0].id
          }

          if (userDocId) {
            const userRef = doc(db, 'users', userDocId)
            const userSnap = await getDocs(query(collection(db, 'users'), where('__name__', '==', userDocId)))
            const currentStrikes = userSnap.empty ? 0 : (userSnap.docs[0].data().strike_count || 0)
            const newStrikes = currentStrikes + 1

            if (newStrikes >= 3) {
              await updateDoc(userRef, { strike_count: increment(1), status: 'SUSPENDED' })
              // Notify student their account is suspended
              await addDoc(collection(db, 'admin_messages'), {
                subject: 'Account Suspended',
                message: `Your LCspace account has been suspended after receiving 3 strikes. Your booking (${booking.id}) for ${booking.room_name || booking.facility} on ${booking.date || booking.booking_date} was marked as No-Show, resulting in your 3rd strike.\n\nPlease visit the admin desk to appeal or resolve this matter.`,
                recipient_uid: booking.user_id || userDocId,
                recipient_id: booking.student_id || userDocId,
                type: 'alert',
                sender_uid: 'system',
                created_at: serverTimestamp(),
              })
            } else {
              await updateDoc(userRef, { strike_count: increment(1) })
              // Notify student of the strike
              await addDoc(collection(db, 'admin_messages'), {
                subject: `No-Show Strike (${newStrikes}/3)`,
                message: `You have received a strike for missing your booking (${booking.id}) for ${booking.room_name || booking.facility} on ${booking.date || booking.booking_date} at ${booking.time}.\n\nYou now have ${newStrikes} of 3 strikes. Reaching 3 strikes will result in account suspension. If you believe this is a mistake, please contact the admin desk.`,
                recipient_uid: booking.user_id || userDocId,
                recipient_id: booking.student_id || userDocId,
                type: 'alert',
                sender_uid: 'system',
                created_at: serverTimestamp(),
              })
            }
          }
        } catch (err) {
          console.error('No-Show mark failed:', err.message)
        }
      }
    })
  }

  function deleteBooking(firestoreId) {
    setAlertConfig({
      type: 'confirm',
      title: 'Delete Reservation',
      message: 'Are you sure you want to permanently delete this reservation?',
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'bookings', firestoreId))
        } catch (err) {
          console.error('Delete failed:', err.message)
        }
      }
    })
  }

  // Bulk-delete every reservation on a given date (YYYY-MM-DD). Used to reset a
  // day's slots. Admin-authenticated, so Firestore rules permit the deletes.
  function clearBookingsForDate(dateStr) {
    if (!dateStr) return
    const label = (() => {
      const [y, m, d] = dateStr.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    })()
    const targets = bookings.filter(b => b.booking_date === dateStr)
    if (targets.length === 0) {
      setAlertConfig({ type: 'alert', title: 'Nothing to clear', message: `There are no reservations dated ${label}.` })
      return
    }
    setAlertConfig({
      type: 'confirm',
      variant: 'danger',
      destructive: true,
      title: `Clear ${targets.length} reservation${targets.length === 1 ? '' : 's'}?`,
      message: `This permanently deletes ALL ${targets.length} reservation(s) dated ${label} (every student, every status). This frees the slots and cannot be undone.`,
      confirmLabel: 'Delete all',
      onConfirm: async () => {
        for (const b of targets) {
          if (!b.firestoreId) continue
          try {
            await deleteDoc(doc(db, 'bookings', b.firestoreId))
            await deleteDoc(doc(db, 'cyberspace_tokens', b.firestoreId)).catch(() => { })
          } catch (err) {
            console.warn('Bulk delete failed for', b.firestoreId, err.message)
          }
        }
      }
    })
  }

  function handleSignOut() {
    sessionStorage.removeItem('admin_user')
    signOut(auth).catch(() => { })
    navigate('/admin-login')
  }

  const todayStr = localISO(new Date())
  const shortToday = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) // e.g. "May 18, 2026"

  // Robust today-check: matches booking_date (YYYY-MM-DD), date ("May 18, 2026"), or created_at timestamp
  function isToday(b) {
    if (b.booking_date && b.booking_date === todayStr) return true
    if (b.date && b.date.includes(shortToday)) return true
    if (!b.booking_date && !b.date && b.created_at) {
      const cat = b.created_at?.seconds ? new Date(b.created_at.seconds * 1000) : new Date(b.created_at || 0)
      return localISO(cat) === todayStr
    }
    return false
  }

  const todayBookingsList = bookings.filter(isToday)

  const stats = {
    total: todayBookingsList.length,
    confirmed: todayBookingsList.filter(b => b.status === 'Confirmed').length,
    checkedIn: todayBookingsList.filter(b => b.status === 'Checked-In' || b.status === 'Active').length,
    noShows: todayBookingsList.filter(b => b.status === 'No-Show').length,
    occupancy: Math.min(100, Math.floor((todayBookingsList.filter(b => b.status === 'Checked-In' || b.status === 'Active').length / 20) * 100)),
  }

  const [pendingCount, setPendingCount] = useState(0)
  const [appealCount, setAppealCount] = useState(0)

  useEffect(() => {
    const q1 = query(collection(db, 'users'), where('status', '==', 'pending'), where('role', '==', 'student'))
    const unsub1 = onSnapshot(q1, snap => setPendingCount(snap.size), err => console.warn('Pending count error:', err.message))

    const q2 = query(collection(db, 'appeals'), where('status', '==', 'pending'))
    const unsub2 = onSnapshot(q2, snap => setAppealCount(snap.size), err => console.warn('Appeal count error:', err.message))

    return () => { unsub1(); unsub2() }
  }, [])

  // Section-grouped navigation — scannable, ordered operations → comms → management → insights.
  const NAV_SECTIONS = [
    {
      label: 'Operations',
      items: [
        { key: 'command', Icon: Shield, label: 'Overview' },
        { key: 'checkin', Icon: UserCheck, label: 'Check-In Desk' },
        { key: 'approvals', Icon: Clock, label: 'Approvals', badge: pendingCount },
        { key: 'appeals', Icon: Scale, label: 'Strike Appeals', badge: appealCount },
      ],
    },
    {
      label: 'Communication',
      items: [
        { key: 'mail', Icon: Mail, label: 'Mail System' },
        { key: 'help', Icon: HelpCircle, label: 'Help Tickets' },
        { key: 'announcements', Icon: Megaphone, label: 'Announcements' },
      ],
    },
    {
      label: 'Management',
      items: [
        { key: 'registry', Icon: Users, label: 'Registry' },
        { key: 'facilities', Icon: Building2, label: 'Facilities' },
        { key: 'cyberspace', Icon: Monitor, label: 'Cyberspace' },
      ],
    },
    {
      label: 'Insights',
      items: [
        { key: 'analytics', Icon: BarChart2, label: 'Analytics' },
        { key: 'history', Icon: Archive, label: 'History' },
      ],
    },
  ]

  // Title + subtitle shown in the top bar for each view.
  const VIEW_META = {
    command: { label: 'Overview', subtitle: "Today's activity at a glance" },
    checkin: { label: 'Check-In Desk', subtitle: 'Process student arrivals and no-shows' },
    approvals: { label: 'Approvals', subtitle: 'Review and approve new registrations' },
    appeals: { label: 'Strike Appeals', subtitle: 'Review strike-reset requests' },
    mail: { label: 'Mail System', subtitle: 'Messages to and from students' },
    help: { label: 'Help Tickets', subtitle: 'Respond to student support requests' },
    announcements: { label: 'Announcements', subtitle: 'Broadcast campus-wide notices' },
    registry: { label: 'Registry', subtitle: 'Student accounts and records' },
    facilities: { label: 'Facilities', subtitle: 'Rooms and availability' },
    cyberspace: { label: 'Cyberspace', subtitle: 'Virtual session access codes' },
    analytics: { label: 'Analytics', subtitle: 'Usage trends and insights' },
    history: { label: 'History', subtitle: 'Past reservations and outcomes' },
    settings: { label: 'Account Settings', subtitle: 'Manage your administrator profile' },
  }

  if (loading) return <LoadingScreen type="admin" />

  return (
    <div className="flex h-screen bg-[#F0F4FF] overflow-hidden">
      {/* ── Admin Sidebar ── */}
      <aside className="w-64 bg-[#262367] flex flex-col fixed inset-y-0 left-0 z-30 border-r border-white/10">

        {/* Brand */}
        <div className="h-[60px] flex items-center gap-3 px-5 border-b border-white/10 flex-shrink-0">
          <img
            src="/assets/img/Schoollogo.png" alt="USPF"
            className="w-8 h-8 object-contain flex-shrink-0"
            onError={e => { e.target.style.display = 'none' }}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white leading-tight">LCspace <span className="text-white">Admin</span></p>
            <p className="text-[10px] text-[#F5C900] leading-tight mt-0.5">Administration Panel</p>
          </div>
        </div>

        {/* Nav — grouped into labeled sections */}
        <nav className="flex-1 px-3 py-3 overflow-y-auto">
          {NAV_SECTIONS.map(section => (
            <div key={section.label} className="mb-4">
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map(({ key, Icon, label, badge }) => (
                  <button key={key} onClick={() => setView(key)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${view === key
                      ? 'bg-white/10 text-white font-medium'
                      : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
                      }`}>
                    <Icon size={15} className={`flex-shrink-0 ${view === key ? 'text-[#F5C900]' : ''}`} />
                    <span className="flex-1">{label}</span>
                    {badge > 0 && (
                      <span className="bg-[#F5C900] text-[#262367] text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                        {badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {/* Account Settings (standalone, as before) */}
          <div className="space-y-0.5">
            <button onClick={() => setView('settings')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${view === 'settings'
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
                }`}>
              <Settings size={15} className={`flex-shrink-0 ${view === 'settings' ? 'text-[#F5C900]' : ''}`} />
              <span className="flex-1">Account Settings</span>
            </button>
          </div>
        </nav>

        {/* Log out */}
        <div className="px-3 py-3 border-t border-white/10 flex-shrink-0">
          <button onClick={handleSignOut}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/50 hover:text-white hover:bg-white/[0.05] transition-colors">
            <LogOut size={15} className="flex-shrink-0" />
            Log Out
          </button>
        </div>

      </aside>

      {/* ── Main Content ── */}
      <div className="ml-64 flex-1 flex flex-col overflow-hidden">
        {/* TopBar */}
        <header className="h-[60px] bg-white border-b border-gray-200 flex items-center justify-between px-8 flex-shrink-0">
          <h1 className="text-sm font-semibold text-gray-900">
            {VIEW_META[view]?.label || 'Dashboard'}
          </h1>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs font-semibold text-gray-800 leading-tight">{adminProfile.name || 'Admin'}</p>
              <p className="text-[10px] text-gray-400">Administrator</p>
            </div>
            <img
              src={`https://ui-avatars.com/api/?name=${encodeURIComponent(adminProfile.name || 'Admin')}&background=F5C900&color=262367&size=40&rounded=true`}
              className="w-8 h-8 rounded-full border border-gray-200"
              alt="Admin"
            />
          </div>
        </header>

        <main className="flex-1 overflow-auto p-8">
          <div className="max-w-6xl mx-auto animate-in fade-in duration-300">
            {bookingsError && (
              <div className="mb-5 flex items-start gap-3 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-bold text-red-700">Couldn't load reservations from the server</p>
                  <p className="text-xs text-red-600 mt-0.5">
                    Reason: <span className="font-mono">{bookingsError}</span>. Showing locally cached data only.
                    Try logging out and back in.
                  </p>
                </div>
                <button onClick={handleSignOut} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition flex-shrink-0">
                  Re-login
                </button>
              </div>
            )}
            {view === 'command' && <CommandCenter stats={stats} bookings={bookings} updateStatus={updateStatus} deleteBooking={deleteBooking} markNoShow={markNoShow} clearBookingsForDate={clearBookingsForDate} />}
            {view === 'approvals' && <Approvals setAlertConfig={setAlertConfig} />}
            {view === 'appeals' && <StrikeAppeals setAlertConfig={setAlertConfig} />}
            {view === 'registry' && <Registry setAlertConfig={setAlertConfig} />}
            {view === 'facilities' && <Facilities bookings={bookings} />}
            {view === 'announcements' && <Announcements setAlertConfig={setAlertConfig} />}
            {view === 'mail' && <AdminMail setAlertConfig={setAlertConfig} />}
            {view === 'help' && <AdminHelp setAlertConfig={setAlertConfig} />}
            {view === 'checkin' && <CheckInDesk bookings={bookings} updateStatus={updateStatus} markNoShow={markNoShow} />}
            {view === 'analytics' && <Analytics bookings={bookings} />}
            {view === 'history' && <BookingHistory bookings={bookings} />}
            {view === 'cyberspace' && <CyberspaceAccess />}
            {view === 'settings' && <AccountSettings profile={adminProfile} setProfile={setAdminProfile} />}
          </div>
        </main>
      </div>

      <AlertModal config={alertConfig} onClose={() => setAlertConfig(null)} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// COMMAND CENTER
// ─────────────────────────────────────────────────────────────

function CommandCenter({ stats, bookings, updateStatus, deleteBooking, markNoShow, clearBookingsForDate }) {
  const [rejectModal, setRejectModal] = useState(null) // { booking, reason, submitting }
  const [confirmingId, setConfirmingId] = useState(null)
  // Date for the "clear a day" reset tool — defaults to tomorrow.
  const [clearDate, setClearDate] = useState(() => {
    const t = new Date(); t.setDate(t.getDate() + 1)
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })

  async function handleConfirm(booking) {
    setConfirmingId(booking.firestoreId)
    try {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let token = ''
      for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)]
      const hash = await sha256(token)
      const todayStr = new Date().toISOString().slice(0, 10)
      await Promise.all([
        updateDoc(doc(db, 'bookings', booking.firestoreId), {
          status: 'Confirmed',
          cyberspace_token_hash: hash,
          confirmed_at: serverTimestamp(),
        }),
        setDoc(doc(db, 'cyberspace_tokens', booking.firestoreId), {
          token,
          student_name: booking.student_name || booking.name || 'Student',
          student_id: booking.student_id || '',
          room_name: booking.room_name || booking.facility || '',
          time: booking.time || '',
          date: todayStr,
          created_at: serverTimestamp(),
        }),
      ])
    } catch (err) {
      console.error('Confirm failed:', err.message)
    }
    setConfirmingId(null)
  }

  async function confirmReject() {
    if (!rejectModal || !rejectModal.reason.trim()) return
    const b = rejectModal.booking
    const reason = rejectModal.reason.trim()
    setRejectModal(prev => ({ ...prev, submitting: true }))
    try {
      // 1. Cancel booking with reason
      await updateDoc(doc(db, 'bookings', b.firestoreId), {
        status: 'Cancelled',
        rejection_reason: reason,
        rejected_at: serverTimestamp(),
      })
      try { await deleteDoc(doc(db, 'cyberspace_tokens', b.firestoreId)) } catch { }
      // 2. Notify rejected student
      await addDoc(collection(db, 'admin_messages'), {
        subject: 'Booking Request Declined',
        message: `Hi ${b.student_name || b.name || 'Student'},\n\nYour reservation request for ${b.room_name || b.facility} on ${b.date || b.booking_date} at ${b.time} has been declined.\n\nReason: ${reason}\n\n— LCspace Administration`,
        recipient_id: b.student_id,
        recipient_uid: b.user_id || null,
        type: 'booking_rejected',
        created_at: serverTimestamp(),
      })
      setRejectModal(null)
    } catch (err) {
      console.error('Reject failed:', err)
      setRejectModal(prev => ({ ...prev, submitting: false }))
    }
  }

  const STAT_CARDS = [
    {
      label: "Today's Traffic",
      value: stats.total,
      sub: 'Total reservations',
      Icon: Activity,
      iconColor: 'text-[#262367]',
      iconBg: 'bg-[#262367]/10',
    },
    {
      label: 'Currently Checked-In',
      value: stats.checkedIn,
      sub: 'Active sessions',
      Icon: CheckCircle2,
      iconColor: 'text-emerald-600',
      iconBg: 'bg-emerald-50',
    },
    {
      label: 'No-Show Alerts',
      value: stats.noShows,
      sub: 'Action required',
      Icon: AlertCircle,
      iconColor: 'text-rose-600',
      iconBg: 'bg-rose-50',
    },
    {
      label: 'Occupancy',
      value: `${stats.occupancy}%`,
      sub: 'Current capacity',
      Icon: Users,
      iconColor: 'text-amber-600',
      iconBg: 'bg-amber-50',
    },
  ]

  const todayStr = localISO(new Date())
  const shortToday = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  // Robust filter: matches YYYY-MM-DD, human-readable date, or created_at fallback
  const todayBookings = bookings.filter(b => {
    if (b.booking_date && b.booking_date === todayStr) return true
    if (b.date && b.date.includes(shortToday)) return true
    if (!b.booking_date && !b.date && b.created_at) {
      const cat = b.created_at?.seconds ? new Date(b.created_at.seconds * 1000) : new Date(b.created_at || 0)
      return localISO(cat) === todayStr
    }
    return false
  })

  // The queue shows today's bookings PLUS every still-actionable booking of ANY date
  // (pending approvals, upcoming confirmed sessions) — so a newly created reservation
  // for a future date always appears and can be approved.
  const ACTIONABLE = ['pending', 'confirmed', 'checked-in', 'active']
  const seen = new Set()
  const displayBookings = [
    ...todayBookings,
    ...bookings.filter(b => b.status && ACTIONABLE.includes(b.status.toLowerCase())),
  ].filter(b => {
    const k = b.firestoreId || b.id
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const pendingCount = displayBookings.filter(b => b.status === 'Pending').length
  const queueLabel = `${displayBookings.length} ${displayBookings.length === 1 ? 'booking' : 'bookings'}${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`

  // Group the queue by day so the admin always sees which date they're acting on.
  const dayGroups = {}
  displayBookings.forEach(b => {
    const key = b.booking_date || b.date || 'Unscheduled'
    if (!dayGroups[key]) dayGroups[key] = []
    dayGroups[key].push(b)
  })
  const isIso = k => /^\d{4}-\d{2}-\d{2}$/.test(k)
  // Show every operating day (Mon–Fri) from TODAY through the week of the latest
  // booking — past days are hidden, and a reservation always lands under its weekday.
  const _t = new Date()
  const today0 = new Date(_t); today0.setHours(0, 0, 0, 0)
  const todayKey = localISO(today0)
  const monday = new Date(today0); monday.setDate(today0.getDate() - ((today0.getDay() + 6) % 7))
  let endDate = new Date(monday); endDate.setDate(monday.getDate() + 4) // this Friday
  const bookingDates = Object.keys(dayGroups).filter(isIso).sort()
  const maxBooking = bookingDates[bookingDates.length - 1]
  if (maxBooking) {
    const mb = new Date(maxBooking + 'T00:00')
    const mbFri = new Date(mb); mbFri.setDate(mb.getDate() - ((mb.getDay() + 6) % 7) + 4) // Friday of booking's week
    if (mbFri > endDate) endDate = mbFri
  }
  const dayKeys = []
  for (let cur = new Date(today0); cur <= endDate; cur.setDate(cur.getDate() + 1)) {
    const dow = cur.getDay()
    if (dow >= 1 && dow <= 5) dayKeys.push(localISO(cur)) // Mon–Fri, today onward
  }
  // Append future booking dates outside the range; drop past dates entirely.
  const extraKeys = Object.keys(dayGroups).filter(k => !dayKeys.includes(k))
  const sortedDayKeys = [
    ...dayKeys,
    ...extraKeys.filter(k => isIso(k) && k >= todayKey).sort(),
    ...extraKeys.filter(k => !isIso(k)),
  ]
  const fmtDayHeader = key => {
    // key is YYYY-MM-DD; render a clear weekday + date label
    const d = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(key + 'T00:00') : null
    if (!d || isNaN(d)) return { weekday: '', label: key }
    return {
      weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
      label: d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Overview</h2>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {STAT_CARDS.map(({ label, value, sub, Icon, iconColor, iconBg }) => (
          <div key={label} className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className="flex items-start justify-between mb-3">
              <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center`}>
                <Icon className={`w-5 h-5 ${iconColor}`} />
              </div>
            </div>
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{value}</p>
            <p className="text-[10px] text-gray-400 mt-2">{sub}</p>
          </div>
        ))}
      </div>

      {/* Booking stream */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">Operating Queue</h3>
            <span className="text-xs text-gray-400">{queueLabel}</span>
          </div>
          {/* Reset tool — bulk-delete all reservations on a chosen date (defaults to tomorrow) */}
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={clearDate}
              onChange={e => setClearDate(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-700 focus:outline-none focus:border-[#262367] focus:ring-1 focus:ring-[#262367]"
            />
            <button
              onClick={() => clearBookingsForDate?.(clearDate)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 border border-red-200 text-xs font-bold hover:bg-red-100 transition"
              title="Delete all reservations on the selected date"
            >
              <Trash2 className="w-3.5 h-3.5" /> Clear day
            </button>
          </div>
        </div>
        {(
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100">
                  {['ID', 'Student', 'Facility', 'Date', 'Time', 'Status', 'Action'].map(h => (
                    <th key={h} className="text-left pb-3 pr-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sortedDayKeys.map((dateKey, gi) => {
                  const dh = fmtDayHeader(dateKey)
                  const isTodayGroup = dateKey === todayStr
                  const group = dayGroups[dateKey] || []
                  return (
                  <Fragment key={dateKey}>
                    {/* Day separator — horizontal divider + clear date label */}
                    <tr>
                      <td colSpan={7} className="pt-5 pb-3 border-t-2 border-gray-200">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`px-2.5 py-1 rounded-lg text-xs font-extrabold ${isTodayGroup ? 'bg-[#262367] text-white' : 'bg-gray-100 text-gray-700'}`}>
                            {dh.weekday || 'Unscheduled'}
                          </span>
                          <span className="text-xs text-gray-500 font-semibold">{dh.label}</span>
                          {isTodayGroup && (
                            <span className="px-2 py-0.5 rounded-full bg-[#F5C900] text-[#262367] text-[10px] font-extrabold uppercase tracking-wide">Today</span>
                          )}
                          <span className="text-[11px] text-gray-400 ml-auto">
                            {group.length} booking{group.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {group.length === 0 ? (
                      <tr><td colSpan={7} className="py-3 text-xs text-gray-300 italic">No reservations</td></tr>
                    ) : group.map(b => (
                  <tr key={b.firestoreId || b.id} className="hover:bg-gray-50/50">
                    <td className="py-3 pr-4 font-mono text-xs font-bold text-[#262367]">{b.id || '—'}</td>
                    <td className="py-3 pr-4 font-medium text-gray-800">{b.student_name || b.name || 'Student'}</td>
                    <td className="py-3 pr-4 text-gray-600">{b.room_name || b.facility || '—'}</td>
                    <td className="py-3 pr-4 text-gray-500 text-xs whitespace-nowrap">{b.date || b.booking_date || '—'}</td>
                    <td className="py-3 pr-4 text-gray-500">{b.time || '—'}</td>
                    <td className="py-3 pr-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${STATUS_STYLES[b.status] || 'bg-gray-100 text-gray-600'}`}>
                        {b.status}
                      </span>
                      {b.rejection_reason && (
                        <p className="text-[10px] text-gray-400 mt-0.5 max-w-[120px] truncate" title={b.rejection_reason}>
                          {b.rejection_reason}
                        </p>
                      )}
                    </td>
                    <td className="py-3 flex gap-2 items-center">
                      {b.status === 'Confirmed' && (
                        <>
                          <button onClick={() => updateStatus(b.firestoreId, 'Checked-In')}
                            className="px-3 py-1.5 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg text-xs font-bold transition">
                            Check-In
                          </button>
                          <button onClick={() => markNoShow(b)}
                            className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-bold transition">
                            No-Show
                          </button>
                        </>
                      )}
                      {(b.status === 'Checked-In' || b.status === 'Active') && (
                        <button onClick={() => updateStatus(b.firestoreId, 'Done')}
                          className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold transition flex items-center gap-1">
                          <Check className="w-3 h-3" /> Done
                        </button>
                      )}
                      {b.status === 'Done' && (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-bold" title={b.auto_done ? 'Auto-completed when time slot ended' : 'Marked done by admin'}>
                          <Check className="w-3.5 h-3.5" /> Completed{b.auto_done ? ' · auto' : ''}
                        </span>
                      )}
                      {b.status === 'Pending' && (
                        <>
                          <button onClick={() => handleConfirm(b)} disabled={confirmingId === b.firestoreId}
                            className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition disabled:opacity-50 flex items-center gap-1">
                            {confirmingId === b.firestoreId
                              ? <div className="w-3 h-3 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin" />
                              : 'Confirm'}
                          </button>
                          <button onClick={() => setRejectModal({ booking: b, reason: '', submitting: false })}
                            className="px-3 py-1.5 bg-orange-50 hover:bg-orange-100 text-orange-600 rounded-lg text-xs font-bold transition">
                            Reject
                          </button>
                        </>
                      )}
                      <button onClick={() => deleteBooking(b.firestoreId)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition ml-auto" title="Delete Booking">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                    ))}
                  </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Rejection reason modal ── */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="px-6 pt-6 pb-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900 text-lg">Decline Reservation</h3>
              <p className="text-xs text-gray-500 mt-1">
                <span className="font-mono font-bold text-[#262367]">{rejectModal.booking.id}</span>
                {' · '}{rejectModal.booking.student_name || rejectModal.booking.name}
                {' · '}{rejectModal.booking.room_name || rejectModal.booking.facility}
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Reason for declining <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={rejectModal.reason}
                  onChange={e => setRejectModal(prev => ({ ...prev, reason: e.target.value }))}
                  placeholder="e.g. Room unavailable for maintenance, time slot already reserved, invalid request details…"
                  rows={3}
                  autoFocus
                  disabled={rejectModal.submitting}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 text-sm px-3.5 py-2.5 text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-[#262367] focus:ring-2 focus:ring-[#262367]/15 transition resize-none"
                />
                <p className="text-[11px] text-gray-400 mt-1.5">This reason will be sent to the student's inbox and shown on their booking.</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setRejectModal(null)}
                  disabled={rejectModal.submitting}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmReject}
                  disabled={!rejectModal.reason.trim() || rejectModal.submitting}
                  className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-bold transition disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {rejectModal.submitting
                    ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Processing…</>
                    : 'Decline & Notify Student'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// APPROVALS
// ─────────────────────────────────────────────────────────────



function Approvals({ setAlertConfig }) {
  const [pending, setPending] = useState([])

  useEffect(() => {
    const q = query(collection(db, 'users'), where('status', '==', 'pending'), where('role', '==', 'student'))
    const unsub = onSnapshot(q, snap => {
      setPending(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
    }, err => console.warn('Approvals error:', err.message))
    return unsub
  }, [])

  async function handleApprove(user) {
    try {
      await updateDoc(doc(db, 'users', user.uid), { status: 'ACTIVE' })
      // Sync department to csv_data registry so admin views stay consistent
      if (user.department && user.student_id) {
        const csvSnap = await getDocs(query(
          collection(db, 'csv_data'),
          where('student_id', '==', user.student_id),
          limit(1)
        ))
        if (!csvSnap.empty) {
          await updateDoc(doc(db, 'csv_data', csvSnap.docs[0].id), {
            department: user.department,
            name: user.name || csvSnap.docs[0].data().name || '',
            email: user.email || csvSnap.docs[0].data().email || '',
          })
        }
      }
    } catch (err) {
      console.error(err)
      setAlertConfig({ type: 'alert', variant: 'danger', title: 'Approval failed', message: 'Unable to approve this student. Please try again.' })
    }
  }

  function handleReject(uid) {
    setAlertConfig({
      type: 'confirm',
      variant: 'danger',
      destructive: true,
      title: 'Reject this registration?',
      message: 'The student will not be able to log in. This can be undone later by changing their status.',
      confirmLabel: 'Reject',
      onConfirm: async () => {
        try {
          await updateDoc(doc(db, 'users', uid), { status: 'rejected' })
        } catch (err) {
          console.error(err)
          setAlertConfig({ type: 'alert', variant: 'danger', title: 'Rejection failed', message: 'Unable to reject this student. Please try again.' })
        }
      }
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Pending Approvals</h2>
        {pending.length > 0 && (
          <span className="px-3 py-1 bg-[#FEF9C3] text-[#262367] rounded-full text-sm font-bold border border-[#F5C900]">
            {pending.length} awaiting approval
          </span>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {pending.length === 0 ? (
          <p className="text-center py-16 text-gray-400 text-sm">No pending approvals. All caught up!</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Student ID', 'Full Name', 'Email', 'Submitted', 'Actions'].map(h => (
                  <th key={h} className="text-left px-5 py-3.5 text-xs font-bold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pending.map(u => (
                <tr key={u.uid} className="hover:bg-gray-50/50">
                  <td className="px-5 py-4 font-mono text-xs font-bold text-[#262367]">{u.student_id}</td>
                  <td className="px-5 py-4 font-medium text-gray-900">{u.name}</td>
                  <td className="px-5 py-4 text-gray-500 text-xs">{u.email}</td>
                  <td className="px-5 py-4 text-gray-400 text-xs">
                    {u.created_at ? new Date(u.created_at.seconds * 1000).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleApprove(u)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg text-xs font-bold transition">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button onClick={() => handleReject(u.uid)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-bold transition">
                        <AlertCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// STRIKE APPEALS
// ─────────────────────────────────────────────────────────────

function StrikeAppeals({ setAlertConfig }) {
  const [appeals, setAppeals] = useState([])
  const [loading, setLoading] = useState(true)

  const [processing, setProcessing] = useState(null)

  useEffect(() => {
    // Filter by status only (no orderBy) so no composite index is required;
    // sort newest-first on the client.
    const q = query(collection(db, 'appeals'), where('status', '==', 'pending'))
    const unsub = onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({ docId: d.id, ...d.data() }))
      rows.sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0))
      setAppeals(rows)
      setLoading(false)
    }, err => {
      console.warn('Appeals error:', err.message)
      setLoading(false)
    })
    return unsub
  }, [])

  async function handleAction(appeal, action) {
    const title = action === 'approved' ? 'Accept Appeal' : 'Reject Appeal'
    const message = action === 'approved'
      ? `Accept ${appeal.student_name}'s appeal? This will reset their strike count to 0 and reactivate their account.`
      : `Reject ${appeal.student_name}'s appeal? Their strikes will remain unchanged.`

    setAlertConfig({
      type: 'confirm',
      title,
      message,
      onConfirm: async () => {
        setProcessing(appeal.docId)
        try {
          if (action === 'approved') {
            const userSnap = await getDocs(query(collection(db, 'users'), where('student_id', '==', appeal.student_id)))
            if (!userSnap.empty) {
              const userRef = doc(db, 'users', userSnap.docs[0].id)
              await updateDoc(userRef, { strike_count: 0, status: 'ACTIVE' })
            }
            await addDoc(collection(db, 'admin_messages'), {
              subject: 'Strike Appeal Accepted',
              message: `Hi ${appeal.student_name},\n\nYour appeal has been accepted. Your strike count has been reset to 0 and your account is now fully active.\n\n— LCspace Administration`,
              recipient_id: appeal.student_id,
              recipient_uid: appeal.user_id,
              type: 'alert',
              sender_uid: 'system',
              created_at: serverTimestamp(),
              is_active: true
            })
          } else {
            await addDoc(collection(db, 'admin_messages'), {
              subject: 'Strike Appeal Declined',
              message: `Hi ${appeal.student_name},\n\nAfter careful review, your strike appeal has been declined. Your strikes remain on your account.\n\n— LCspace Administration`,
              recipient_id: appeal.student_id,
              recipient_uid: appeal.user_id,
              type: 'alert',
              sender_uid: 'system',
              created_at: serverTimestamp(),
              is_active: true
            })
          }

          await updateDoc(doc(db, 'appeals', appeal.docId), {
            status: action,
            resolved_at: serverTimestamp()
          })

        } catch (err) {
          console.error(err)
          setAlertConfig({ type: 'alert', title: 'Action failed', message: 'Something went wrong. Please try again.' })
        } finally {
          setProcessing(null)
        }
      }
    })
  }

  const fmtDate = (ts) => ts
    ? new Date(ts.seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—'
  const fmtTime = (ts) => ts
    ? new Date(ts.seconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Strike Appeals</h2>
        {appeals.length > 0 && (
          <span className="px-3 py-1 bg-[#FEF9C3] text-[#262367] rounded-full text-sm font-bold border border-[#F5C900]">
            {appeals.length} pending {appeals.length === 1 ? 'appeal' : 'appeals'}
          </span>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {loading ? (
          <p className="text-center py-16 text-gray-400 text-sm">Loading appeals…</p>
        ) : appeals.length === 0 ? (
          <p className="text-center py-16 text-gray-400 text-sm">No pending appeals. All caught up!</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {['Student ID', 'Full Name', 'Strikes', 'Appeal Reason', 'Submitted', 'Actions'].map(h => (
                    <th key={h} className="text-left px-5 py-3.5 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {appeals.map(a => {
                  const busy = processing === a.docId
                  const strikes = a.strike_count || 0
                  return (
                    <tr key={a.docId} className="hover:bg-gray-50/50 align-top">
                      <td className="px-5 py-4 font-mono text-xs font-bold text-[#262367] whitespace-nowrap">{a.student_id || '—'}</td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <p className="font-medium text-gray-900">{a.student_name || 'Unknown Student'}</p>
                        {a.student_email && <p className="text-[11px] text-gray-400">{a.student_email}</p>}
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-50 text-red-600 border border-red-100 text-xs font-bold">
                          {strikes} / 3
                        </span>
                      </td>
                      <td className="px-5 py-4 text-gray-600 max-w-xs">
                        <p className="line-clamp-2 italic" title={a.reason}>"{a.reason}"</p>
                      </td>
                      <td className="px-5 py-4 text-gray-400 text-xs whitespace-nowrap">
                        {fmtDate(a.created_at)}{fmtTime(a.created_at) ? <span className="block text-gray-300">{fmtTime(a.created_at)}</span> : ''}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleAction(a, 'approved')} disabled={busy}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg text-xs font-bold transition disabled:opacity-50 whitespace-nowrap">
                            {busy ? <RotateCcw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve & Reset
                          </button>
                          <button onClick={() => handleAction(a, 'rejected')} disabled={busy}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-bold transition disabled:opacity-50 whitespace-nowrap">
                            <AlertCircle className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// BOOKING HISTORY  (completed / cancelled / rejected / no-show)
// ─────────────────────────────────────────────────────────────

function BookingHistory({ bookings }) {
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')

  // Classify a booking into a terminal-history bucket (or null if still active)
  const categorize = (b) => {
    if (b.status === 'Done') return 'done'
    if (b.status === 'No-Show') return 'noshow'
    if (b.status === 'Cancelled') return b.rejection_reason ? 'rejected' : 'cancelled'
    return null
  }

  const whenMs = (b) => {
    const ts = b.done_at || b.resolved_at || b.rejected_at || b.cancelled_at || b.created_at
    if (!ts) return 0
    return ts.seconds ? ts.seconds * 1000 : new Date(ts).getTime() || 0
  }
  const fmtWhen = (b) => {
    const ms = whenMs(b)
    return ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
  }

  const history = bookings
    .map(b => ({ ...b, _cat: categorize(b) }))
    .filter(b => b._cat)
    .sort((a, b) => whenMs(b) - whenMs(a))

  const counts = {
    all: history.length,
    done: history.filter(b => b._cat === 'done').length,
    cancelled: history.filter(b => b._cat === 'cancelled').length,
    rejected: history.filter(b => b._cat === 'rejected').length,
    noshow: history.filter(b => b._cat === 'noshow').length,
  }

  const q = search.trim().toLowerCase()
  const filtered = history.filter(b => {
    if (tab !== 'all' && b._cat !== tab) return false
    if (!q) return true
    return (
      (b.student_name || b.name || '').toLowerCase().includes(q) ||
      (b.student_id || '').toLowerCase().includes(q) ||
      (b.id || '').toLowerCase().includes(q) ||
      (b.room_name || b.facility || '').toLowerCase().includes(q)
    )
  })

  const TABS = [['all', 'All'], ['done', 'Completed'], ['cancelled', 'Cancelled'], ['rejected', 'Rejected'], ['noshow', 'No-Show']]

  const badgeFor = (cat) => {
    const map = {
      done: ['Completed', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
      cancelled: ['Cancelled', 'bg-gray-100 text-gray-600 border-gray-200'],
      rejected: ['Rejected', 'bg-orange-50 text-orange-700 border-orange-200'],
      noshow: ['No-Show', 'bg-red-50 text-red-600 border-red-200'],
    }
    const [label, cls] = map[cat] || ['—', 'bg-gray-100 text-gray-600 border-gray-200']
    return <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-bold border ${cls}`}>{label}</span>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Booking History</h2>
          <p className="text-sm text-gray-500">Completed, cancelled, rejected, and no-show reservations</p>
        </div>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search student, ID, room…"
            className="pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm w-64 focus:outline-none focus:border-[#262367] focus:ring-1 focus:ring-[#262367]"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4 w-fit flex-wrap">
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${tab === key ? 'bg-white text-[#262367] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {label} <span className="text-gray-400">({counts[key]})</span>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-center py-16 text-gray-400 text-sm">No records in this category.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {['Booking ID', 'Student', 'Facility', 'Date', 'Time', 'Outcome', 'Resolved'].map(h => (
                    <th key={h} className="text-left px-5 py-3.5 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(b => (
                  <tr key={b.firestoreId || b.id} className="hover:bg-gray-50/50 align-top">
                    <td className="px-5 py-4 font-mono text-xs font-bold text-[#262367] whitespace-nowrap">{b.id || '—'}</td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      <p className="font-medium text-gray-900">{b.student_name || b.name || '—'}</p>
                      {b.student_id && <p className="text-[11px] text-gray-400 font-mono">{b.student_id}</p>}
                    </td>
                    <td className="px-5 py-4 text-gray-600 whitespace-nowrap">{b.room_name || b.facility || '—'}</td>
                    <td className="px-5 py-4 text-gray-500 text-xs whitespace-nowrap">{b.date || b.booking_date || '—'}</td>
                    <td className="px-5 py-4 text-gray-500 text-xs whitespace-nowrap">{b.time || '—'}</td>
                    <td className="px-5 py-4">
                      {badgeFor(b._cat)}
                      {b._cat === 'rejected' && b.rejection_reason && (
                        <p className="text-[10px] text-gray-400 mt-1 max-w-[220px] italic" title={b.rejection_reason}>"{b.rejection_reason}"</p>
                      )}
                    </td>
                    <td className="px-5 py-4 text-gray-400 text-xs whitespace-nowrap">{fmtWhen(b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────────────────────

const DEPARTMENTS = [
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

function Registry({ setAlertConfig }) {

  const [tab, setTab] = useState('list')
  const [selectedDept, setSelectedDept] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [shownPasswords, setShownPasswords] = useState(new Set())
  const [passwordModal, setPasswordModal] = useState(null)
  const [manualPassword, setManualPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [showManualPass, setShowManualPass] = useState(false)
  const [deptModal, setDeptModal] = useState(null)
  const [deptValue, setDeptValue] = useState('')
  const [savingDept, setSavingDept] = useState(false)
  // student_credentials: { [uid]: string } — stored separately from user docs
  const [credentialsMap, setCredentialsMap] = useState({})

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'student_credentials'), snap => {
      const map = {}
      snap.forEach(d => { map[d.id] = d.data().password || '' })
      setCredentialsMap(map)
    }, () => { })
    return unsub
  }, [])

  function togglePassword(studentId) {
    setShownPasswords(prev => {
      const next = new Set(prev)
      next.has(studentId) ? next.delete(studentId) : next.add(studentId)
      return next
    })
  }

  async function handleSetPassword() {
    if (!manualPassword.trim() || !passwordModal) return
    setSavingPassword(true)
    try {
      const userDoc = registeredDocs.find(u => u.student_id === passwordModal.student_id)
      if (!userDoc) throw new Error('User document not found')
      // Store in student_credentials collection — NOT in the user doc
      await setDoc(doc(db, 'student_credentials', userDoc.uid), { password: manualPassword.trim() })
      setPasswordModal(null)
      setManualPassword('')
      setShowManualPass(false)
    } catch (err) {
      console.error(err)
      setAlertConfig({ type: 'alert', title: 'Error', message: 'Failed to save password. Please try again.' })
    } finally {
      setSavingPassword(false)
    }
  }

  async function handleSendPassword(student) {
    const recipientDoc = registeredDocs.find(u => u.student_id === student.student_id)
    const password = recipientDoc
      ? (credentialsMap[recipientDoc.uid] || recipientDoc.student_password || null)
      : null
    if (!password) {
      setAlertConfig({ type: 'alert', title: 'No Password on File', message: 'No password is recorded for this student. Use "Set" to add one first.' })
      return
    }
    try {
      await addDoc(collection(db, 'admin_messages'), {
        subject: 'Your Account Password',
        message: `Hello ${student.name},\n\nYour registered account password is:\n\n${password}\n\nPlease keep this confidential and consider changing your password after logging in.\n\n— LCspace Administration`,
        recipient_id: student.student_id,
        recipient_uid: recipientDoc?.uid || null,
        type: 'password_reset',
        created_at: serverTimestamp()
      })
      setAlertConfig({ type: 'alert', title: 'Password Sent', message: `Password has been sent to ${student.name}'s inbox.` })
    } catch (err) {
      console.error(err)
      setAlertConfig({ type: 'alert', title: 'Error', message: 'Failed to send password.' })
    }
  }
  async function handleSaveDepartment() {
    if (!deptModal) return
    setSavingDept(true)
    try {
      const userDoc = registeredDocs.find(u => u.student_id === deptModal.student_id)
      if (userDoc) {
        await updateDoc(doc(db, 'users', userDoc.uid), { department: deptValue })
      }
      const csvRow = csvData.find(c => c.student_id === deptModal.student_id)
      if (csvRow) {
        await updateDoc(doc(db, 'csv_data', csvRow.firestoreId), { department: deptValue })
      }
      setDeptModal(null)
      setDeptValue('')
    } catch (err) {
      console.error(err)
      setAlertConfig({ type: 'alert', title: 'Error', message: 'Failed to save department. Please try again.' })
    } finally {
      setSavingDept(false)
    }
  }

  const [csvData, setCsvData] = useState([])
  const [registeredIds, setRegisteredIds] = useState(new Set())
  const [registeredDocs, setRegisteredDocs] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState(null)
  const [newStudent, setNewStudent] = useState({ student_id: '', name: '', email: '', department: '' })
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    const unsubCsv = onSnapshot(collection(db, 'csv_data'), snap => {
      setCsvData(snap.docs.map(d => ({ firestoreId: d.id, ...d.data() })))
    })
    const q = query(collection(db, 'users'), where('role', '==', 'student'))
    const unsubUsers = onSnapshot(q, snap => {
      // Rejected/declined accounts are hidden from the registry entirely.
      const docs = snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.status !== 'rejected')
      setRegisteredIds(new Set(docs.map(d => d.student_id)))
      setRegisteredDocs(docs)
    })
    return () => { unsubCsv(); unsubUsers() }
  }, [])

  async function handleCSVUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    setUploadResult(null)

    const text = await file.text()
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) { setUploading(false); return }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
    let added = 0, skipped = 0

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      const row = {}
      headers.forEach((h, idx) => { row[h] = values[idx] || '' })

      const sid = row.student_id || row.id || row.studentid
      if (!sid) { skipped++; continue }

      const exists = csvData.find(c => c.student_id === sid)
      if (exists) { skipped++; continue }

      await addDoc(collection(db, 'csv_data'), {
        student_id: sid,
        name: row.name || row.full_name || '',
        email: row.email || '',
        department: row.department || '',
      })
      added++
    }

    setUploadResult({ added, skipped })
    setUploading(false)
    e.target.value = ''
  }

  async function handleAddStudent(e) {
    e.preventDefault()
    setMsg('')
    const exists = csvData.find(c => c.student_id === newStudent.student_id)
    if (exists) { setMsg('Student ID already in registry.'); return }
    setAdding(true)
    await addDoc(collection(db, 'csv_data'), {
      student_id: newStudent.student_id,
      name: newStudent.name,
      email: newStudent.email || '',
      department: newStudent.department || '',
    })
    setNewStudent({ student_id: '', name: '', email: '', department: '' })
    setMsg('Student added to registry.')
    setAdding(false)
  }

  function handleRemove(firestoreId) {
    setAlertConfig({
      type: 'confirm',
      variant: 'danger',
      destructive: true,
      title: 'Remove from registry?',
      message: 'This student will be removed from the enrollment registry and will no longer be able to register an account.',
      confirmLabel: 'Remove',
      onConfirm: async () => { await deleteDoc(doc(db, 'csv_data', firestoreId)) }
    })
  }

  function handleDeleteAccount(student) {
    const userDoc = registeredDocs.find(u => u.student_id === student.student_id)
    if (!userDoc) return
    setAlertConfig({
      type: 'confirm',
      variant: 'danger',
      destructive: true,
      title: 'Delete Student Account?',
      message: `This will permanently delete ${student.name || 'this student'}'s account. They will no longer be able to log in. This cannot be undone.`,
      confirmLabel: 'Delete Account',
      onConfirm: async () => {
        await deleteDoc(doc(db, 'users', userDoc.uid))
        if (student.firestoreId && !student.isUsersOnly) {
          await deleteDoc(doc(db, 'csv_data', student.firestoreId))
        }
      }
    })
  }

  function handleResetRegistration(studentId) {
    const userDoc = registeredDocs.find(u => u.student_id === studentId)
    if (!userDoc) return
    setAlertConfig({
      type: 'confirm',
      variant: 'warning',
      title: `Reset registration for ${studentId}?`,
      message: 'Their account will be deleted from the system, and the student can register again from scratch.',
      confirmLabel: 'Reset registration',
      onConfirm: async () => { await deleteDoc(doc(db, 'users', userDoc.uid)) }
    })
  }

  async function handlePasswordReset(email) {
    if (!email) {
      window.alert('No email address is listed for this student.')
      return
    }
    if (!window.confirm(`Send a password reset email to ${email}?`)) return
    try {
      await sendPasswordResetEmail(auth, email)
      window.alert('Password reset link sent successfully.')
    } catch (err) {
      console.error(err)
      window.alert('Failed to send reset email. Ensure the student has registered their account.')
    }
  }

  function handleResetPhotoCooldown(student) {
    const userDoc = registeredDocs.find(u => u.student_id === student.student_id)
    if (!userDoc) {
      setAlertConfig({ type: 'alert', variant: 'warning', title: 'Not registered', message: 'This student does not have a registered account yet.' })
      return
    }
    setAlertConfig({
      type: 'confirm',
      variant: 'warning',
      title: `Reset photo cooldown for ${student.name || student.student_id}?`,
      message: 'The student will be able to upload a new profile photo immediately. The 3-month cooldown will restart from their next upload.',
      confirmLabel: 'Reset cooldown',
      onConfirm: async () => {
        try {
          await updateDoc(doc(db, 'users', userDoc.uid), {
            photo_url: null,
            photo_updated_at: null,
          })
          setAlertConfig({ type: 'alert', variant: 'success', title: 'Cooldown reset', message: `${student.name || student.student_id} can now upload a new photo.` })
        } catch (err) {
          console.error(err)
          setAlertConfig({ type: 'alert', variant: 'danger', title: 'Reset failed', message: 'Unable to reset photo cooldown. Please try again.' })
        }
      }
    })
  }

  const TABS = [
    { key: 'list', Icon: Users, label: 'Enrollment List' },
    { key: 'upload', Icon: Upload, label: 'Upload CSV' },
    { key: 'add', Icon: UserPlus, label: 'Add Student' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h2 className="text-2xl font-bold text-gray-900">Student Registry</h2>
        <div className="flex gap-2">
          {TABS.map(({ key, Icon: TabIcon, label }) => (
            <button key={key} onClick={() => { setTab(key); setMsg(''); setUploadResult(null) }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition ${tab === key ? 'bg-[#262367] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              <TabIcon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Upload CSV ── */}
      {tab === 'upload' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 max-w-xl">
          <h3 className="font-bold text-gray-900 mb-1">Bulk Import from CSV</h3>
          <p className="text-sm text-gray-500 mb-4">CSV must have a <code className="bg-gray-100 px-1 rounded text-xs">student_id</code> column. Optional: <code className="bg-gray-100 px-1 rounded text-xs">name</code>, <code className="bg-gray-100 px-1 rounded text-xs">email</code></p>
          <div className="mb-6 bg-gray-50 rounded-xl p-4 font-mono text-xs text-gray-500 leading-relaxed">
            student_id,name,email<br />
            2023-00001,Juan dela Cruz,juan@uspf.edu.ph<br />
            2023-00002,Maria Santos,maria@uspf.edu.ph
          </div>
          <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition ${uploading ? 'border-gray-200 bg-gray-50 cursor-not-allowed' : 'border-[#262367]/30 hover:border-[#262367] hover:bg-[#262367]/5'}`}>
            {uploading
              ? <Clock className="w-8 h-8 text-gray-400 mb-2 animate-spin" />
              : <Upload className="w-8 h-8 text-[#262367]/40 mb-2" />}
            <span className="text-sm font-semibold text-gray-600">{uploading ? 'Importing…' : 'Click to select CSV file'}</span>
            <input type="file" accept=".csv" className="hidden" onChange={handleCSVUpload} disabled={uploading} />
          </label>
          {uploadResult && (
            <div className="mt-4 p-4 bg-green-50 rounded-xl text-sm">
              <p className="font-bold text-green-700 mb-1">Import Complete</p>
              <p className="text-green-600 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Added: {uploadResult.added} students</p>
              <p className="text-gray-500 mt-1">Skipped (already in registry): {uploadResult.skipped}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Add Individual ── */}
      {tab === 'add' && (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 max-w-md">
          <h3 className="font-bold text-gray-900 mb-6">Add Individual Student</h3>
          {msg && (
            <div className={`mb-4 p-3 rounded-xl text-sm font-medium flex items-center gap-2 ${msg.includes('added') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
              {msg.includes('added') ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
              {msg}
            </div>
          )}
          <form onSubmit={handleAddStudent} className="space-y-4">
            {[
              { key: 'student_id', label: 'Student ID', placeholder: '2023-00001', required: true },
              { key: 'name', label: 'Full Name', placeholder: 'Juan dela Cruz', required: false },
              { key: 'email', label: 'Email (optional)', placeholder: 'juan@uspf.edu.ph', required: false },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">{f.label}</label>
                <input
                  value={newStudent[f.key]}
                  onChange={e => setNewStudent(p => ({ ...p, [f.key]: e.target.value }))}
                  required={f.required}
                  placeholder={f.placeholder}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#262367]"
                />
              </div>
            ))}
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Department (optional)</label>
              <select
                value={newStudent.department}
                onChange={e => setNewStudent(p => ({ ...p, department: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#262367]"
              >
                <option value="">— Unassigned —</option>
                {DEPARTMENTS.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={adding}
              className="w-full bg-[#262367] text-white py-3 rounded-xl font-semibold text-sm hover:bg-[#35318c] transition disabled:opacity-50">
              {adding ? 'Adding…' : 'Add to Registry'}
            </button>
          </form>
        </div>
      )}

      {/* ── Enrollment List ── */}
      {tab === 'list' && (() => {
        const csvStudentIds = new Set(csvData.map(c => c.student_id))
        const combinedData = csvData.map(csvUser => {
          const registeredUser = registeredDocs.find(u => u.student_id === csvUser.student_id)
          return {
            ...csvUser,
            name: registeredUser ? registeredUser.name : csvUser.name,
            email: registeredUser ? registeredUser.email : csvUser.email,
            department: registeredUser?.department || csvUser.department || '',
            // Read from new secure collection first, fall back to legacy field
            // on the user doc until migration runs.
            student_password: registeredUser
              ? (credentialsMap[registeredUser.uid] || registeredUser.student_password || null)
              : null
          }
        })

        registeredDocs.forEach(user => {
          if (!csvStudentIds.has(user.student_id)) {
            combinedData.push({
              firestoreId: user.uid,
              student_id: user.student_id,
              name: user.name,
              email: user.email,
              department: user.department || '',
              student_password: credentialsMap[user.uid] || user.student_password || null,
              isUsersOnly: true
            })
          }
        })

        // Department counts for folder badges
        const deptCounts = combinedData.reduce((acc, s) => {
          const k = s.department || 'Unassigned'
          acc[k] = (acc[k] || 0) + 1
          return acc
        }, {})

        // Filter by department + search query
        const q = searchQuery.trim().toLowerCase()
        const filtered = combinedData.filter(s => {
          const deptMatch = selectedDept === 'all' ? true : s.department === selectedDept
          if (!deptMatch) return false
          if (!q) return true
          return (
            (s.student_id || '').toLowerCase().includes(q) ||
            (s.name || '').toLowerCase().includes(q) ||
            (s.email || '').toLowerCase().includes(q)
          )
        })

        const DEPT_ABBR = {
          'College of Computer Studies': 'CCS',
          'College of Engineering': 'COE',
          'College of Business Administration': 'CBA',
          'College of Arts and Sciences': 'CAS',
          'College of Education': 'CED',
          'College of Health and Sciences': 'CHS',
          'College of Criminal Justice': 'CCJ',
          'College of Hospitality Management': 'CHM',
          'Senior High School': 'SHS',
        }

        return (
          <div className="space-y-5">
            {/* Header: title + search */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Browse by</p>
                <h3 className="text-lg font-bold text-gray-900 mt-0.5">School Departments</h3>
              </div>
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by ID, name, or email…"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                  className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-gray-200 bg-white text-sm shadow-sm focus:outline-none focus:border-[#262367] focus:ring-2 focus:ring-[#262367]/15 transition"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Department folder grid */}
            <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-10 gap-2">
              {[
                { key: 'all', label: 'All Students', abbr: 'ALL', count: combinedData.length },
                ...DEPARTMENTS.map(d => ({ key: d, label: d, abbr: DEPT_ABBR[d] || d.slice(0, 3).toUpperCase(), count: deptCounts[d] || 0 })),
              ].map(({ key, label, abbr, count }) => {
                const active = selectedDept === key
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedDept(key)}
                    title={label}
                    className={`group flex flex-col items-center justify-center text-center px-2 py-2.5 rounded-lg border transition-all ${active
                      ? 'bg-[#262367] border-[#262367] shadow-sm'
                      : 'bg-white border-gray-200 hover:border-[#262367]/40'
                      }`}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Folder className={`w-3.5 h-3.5 ${active ? 'text-[#F5C900]' : 'text-[#262367]'}`} />
                      <span className={`text-[11px] font-bold tracking-wider ${active ? 'text-[#F5C900]' : 'text-gray-700'}`}>
                        {abbr}
                      </span>
                      <span className={`text-[9px] font-bold px-1 rounded ${active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                        }`}>
                        {count}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-3.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                <p className="text-sm font-bold text-gray-700">
                  {filtered.length} showing
                  {selectedDept !== 'all' && <span className="text-gray-400 font-normal"> · {selectedDept}</span>}
                  {q && <span className="text-gray-400 font-normal"> · "{searchQuery}"</span>}
                </p>
                <p className="text-xs text-gray-400">{combinedData.length} total · {registeredIds.size} registered</p>
              </div>
              {filtered.length === 0 ? (
                <p className="text-center py-16 text-gray-400 text-sm">
                  {combinedData.length === 0
                    ? 'No students in registry yet. Upload a CSV or add students manually.'
                    : 'No students match the current filters.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        {['Student ID', 'Name', 'Department', 'Email', 'Password', 'Registration', 'Actions'].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filtered.map(s => {
                        const isRegistered = registeredIds.has(s.student_id)
                        const userDoc = registeredDocs.find(d => d.student_id === s.student_id)
                        const isPending = userDoc && userDoc.status === 'pending'

                        return (
                          <tr key={s.firestoreId} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-mono text-xs font-bold text-[#262367] whitespace-nowrap">{s.student_id}</td>
                            <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{s.name || '—'}</td>
                            <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">
                              <button
                                onClick={() => { setDeptModal(s); setDeptValue(s.department || '') }}
                                title="Click to edit department"
                                className="inline-flex items-center gap-1.5 rounded-md hover:ring-1 hover:ring-[#262367]/30 transition"
                              >
                                {s.department
                                  ? <span className="inline-flex items-center gap-1.5 text-[#262367] font-semibold bg-[#262367]/5 px-1.5 py-0.5 rounded whitespace-nowrap">
                                    <Folder className="w-3 h-3" /> {DEPT_ABBR[s.department] || s.department}
                                  </span>
                                  : <span className="text-blue-600 font-semibold flex items-center gap-1 whitespace-nowrap"><Folder className="w-3 h-3" /> Assign</span>}
                              </button>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{s.email || '—'}</td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {s.student_password ? (
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-xs text-gray-800 select-all">
                                    {shownPasswords.has(s.student_id) ? s.student_password : '••••••••'}
                                  </span>
                                  <button onClick={() => togglePassword(s.student_id)}
                                    className="text-gray-400 hover:text-gray-600 transition flex-shrink-0">
                                    {shownPasswords.has(s.student_id) ? <EyeOff size={12} /> : <Eye size={12} />}
                                  </button>
                                  <button onClick={() => { setPasswordModal(s); setManualPassword(s.student_password); setShowManualPass(false) }}
                                    className="text-gray-300 hover:text-gray-500 transition flex-shrink-0" title="Edit password">
                                    <Key size={11} />
                                  </button>
                                </div>
                              ) : isRegistered ? (
                                <button onClick={() => { setPasswordModal(s); setManualPassword(s.student_password || ''); setShowManualPass(false) }}
                                  className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-800 transition">
                                  <Key size={11} /> Set password
                                </button>
                              ) : (
                                <span className="text-[11px] text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {isRegistered
                                ? isPending
                                  ? <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-yellow-50 text-yellow-700">Pending</span>
                                  : <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-green-50 text-green-700">Registered</span>
                                : <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-500">Not Yet</span>
                              }
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                {isRegistered && (
                                  <>
                                    <button onClick={() => handleSendPassword(s)}
                                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-bold transition">
                                      <Send className="w-3.5 h-3.5" /> Send
                                    </button>
                                    <button onClick={() => handleDeleteAccount(s)}
                                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-bold transition"
                                      title="Delete student account">
                                      <UserX className="w-3.5 h-3.5" /> Delete
                                    </button>
                                  </>
                                )}
                                {!s.isUsersOnly && (
                                  <button onClick={() => handleRemove(s.firestoreId)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-bold transition">
                                    <Trash2 className="w-3.5 h-3.5" /> Remove
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
              )}
            </div>
          </div>
        )
      })()}

      {/* Assign / Edit Department Modal */}
      {deptModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">
                {deptModal.department ? 'Edit Department' : 'Assign Department'}
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">{deptModal.name || '—'} · {deptModal.student_id}</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">School Department</label>
                <select
                  value={deptValue}
                  onChange={e => setDeptValue(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition"
                  autoFocus
                >
                  <option value="">— Unassigned —</option>
                  {DEPARTMENTS.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button onClick={() => { setDeptModal(null); setDeptValue('') }}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition">
                  Cancel
                </button>
                <button onClick={handleSaveDepartment} disabled={savingDept}
                  className="flex-1 px-4 py-2 rounded-lg bg-[#262367] text-white text-sm font-semibold hover:bg-[#35318c] transition disabled:opacity-50">
                  {savingDept ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set / Edit Password Modal */}
      {passwordModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">
                {passwordModal.student_password ? 'Edit Password' : 'Set Password'}
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">{passwordModal.name} · {passwordModal.student_id}</p>
            </div>
            <div className="p-6 space-y-4">
              {/* Hidden decoys — prevent browser from injecting admin credentials into the search bar */}
              <input type="text" autoComplete="username" aria-hidden="true" style={{ display: 'none' }} readOnly tabIndex={-1} />
              <input type="password" autoComplete="current-password" aria-hidden="true" style={{ display: 'none' }} readOnly tabIndex={-1} />
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Password</label>
                <div className="relative">
                  <input
                    type={showManualPass ? 'text' : 'password'}
                    value={manualPassword}
                    onChange={e => setManualPassword(e.target.value)}
                    placeholder="Enter password"
                    autoComplete="new-password"
                    className="w-full pr-9 pl-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition font-mono"
                    autoFocus
                  />
                  <button type="button" onClick={() => setShowManualPass(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition">
                    {showManualPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div className="flex gap-3 pt-1">
                <button onClick={() => { setPasswordModal(null); setManualPassword(''); setShowManualPass(false) }}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition">
                  Cancel
                </button>
                <button onClick={handleSetPassword} disabled={savingPassword || !manualPassword.trim()}
                  className="flex-1 px-4 py-2 rounded-lg bg-[#262367] text-white text-sm font-semibold hover:bg-[#35318c] transition disabled:opacity-50">
                  {savingPassword ? 'Saving…' : 'Save Password'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// FACILITIES
// ─────────────────────────────────────────────────────────────

function SingleDoor({ size = 18, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="2" width="16" height="20" rx="1.5" />
      <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

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

const ROOMS_INFO = [
  { name: 'Collaborative Room 1', location: 'Medium Capacity', capacity: 20, Icon: SingleDoor },
  { name: 'Collaborative Room 2', location: 'Medium Capacity', capacity: 20, Icon: SingleDoor },
  { name: "Innovative Makers' Space 1", location: 'Large Capacity', capacity: 30, Icon: DoubleDoor },
  { name: "Innovative Makers' Space 2", location: 'Large Capacity', capacity: 30, Icon: DoubleDoor },
]

function Facilities({ bookings }) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Facilities Status</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {ROOMS_INFO.map(room => {
          const active = bookings.filter(b =>
            (b.room_name === room.name || b.facility === room.name) &&
            (b.status === 'Checked-In' || b.status === 'Active')
          ).length
          const confirmed = bookings.filter(b =>
            (b.room_name === room.name || b.facility === room.name) && b.status === 'Confirmed'
          ).length
          const pct = Math.min(100, Math.round((active / room.capacity) * 100))
          const isOccupied = active > 0

          return (
            <div key={room.name} className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl bg-[#262367]/10 flex items-center justify-center">
                  <room.Icon className="w-5 h-5 text-[#262367]" />
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${isOccupied ? 'bg-orange-50 text-orange-600' : 'bg-green-50 text-green-600'}`}>
                  {isOccupied ? 'OCCUPIED' : 'VACANT'}
                </span>
              </div>
              <p className="font-bold text-gray-900">{room.name}</p>
              <p className="text-xs text-gray-500 mt-1">{room.location}</p>

              <div className="mt-4 space-y-1.5">
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Active Sessions</span><span className="font-bold text-gray-700">{active}</span>
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Upcoming</span><span className="font-bold text-gray-700">{confirmed}</span>
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Capacity</span><span className="font-bold text-gray-700">{room.capacity}</span>
                </div>
              </div>

              <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#F5C900] rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-1">{pct}% utilization</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ANNOUNCEMENTS
// ─────────────────────────────────────────────────────────────

function Announcements({ setAlertConfig }) {
  const [announcements, setAnnouncements] = useState([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    const localFallback = JSON.parse(localStorage.getItem('lcspace_announcements') || '[]')

    const q = query(collection(db, 'announcements'), orderBy('created_at', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setAnnouncements(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }, err => {
      console.warn('Firestore permissions denied. Using local storage for announcements.')
      setAnnouncements(localFallback)

      // Listen for cross-tab updates
      const handleStorage = (e) => {
        if (e.key === 'lcspace_announcements') setAnnouncements(JSON.parse(e.newValue || '[]'))
      }
      window.addEventListener('storage', handleStorage)
      return () => window.removeEventListener('storage', handleStorage)
    })
    return () => unsub()
  }, [])

  async function handlePost(e) {
    e.preventDefault()
    if (!title.trim() || !content.trim()) return
    const cleanTitle = sanitizeText(title, 150)
    const cleanContent = sanitizeText(content, 3000)
    setPosting(true)
    try {
      await addDoc(collection(db, 'announcements'), {
        title: cleanTitle,
        content: cleanContent,
        created_at: serverTimestamp()
      })
      setTitle('')
      setContent('')
    } catch (err) {
      console.warn('Firebase blocked write. Falling back to local storage.')
      const local = JSON.parse(localStorage.getItem('lcspace_announcements') || '[]')
      const updated = [{ id: 'local_' + Date.now(), title: cleanTitle, content: cleanContent, created_at: new Date().toISOString() }, ...local]
      localStorage.setItem('lcspace_announcements', JSON.stringify(updated))
      setAnnouncements(updated)

      setTitle('')
      setContent('')
      setAlertConfig({
        type: 'alert',
        title: 'Offline Mode Active',
        message: 'Your Firestore security rules are blocking writes, so this announcement was saved to local storage instead. It will still show up for students on this device!'
      })
    } finally {
      setPosting(false)
    }
  }

  function handleDelete(id) {
    setAlertConfig({
      type: 'confirm',
      title: 'Delete Announcement',
      message: 'Are you sure you want to delete this announcement?',
      onConfirm: async () => {
        if (id.toString().startsWith('local_')) {
          const local = JSON.parse(localStorage.getItem('lcspace_announcements') || '[]')
          const updated = local.filter(a => a.id !== id)
          localStorage.setItem('lcspace_announcements', JSON.stringify(updated))
          setAnnouncements(updated)
        } else {
          try {
            await deleteDoc(doc(db, 'announcements', id))
          } catch (err) {
            console.error('Delete blocked', err)
          }
        }
      }
    })
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Announcements</h2>
      <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 shadow-sm">
        <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-[#262367]" /> Post New Announcement
        </h3>
        <form onSubmit={handlePost} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. System Maintenance" className="w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#262367]" />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Message</label>
            <textarea value={content} onChange={e => setContent(e.target.value)} required rows={3} placeholder="Write your announcement here..." className="w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#262367]" />
          </div>
          <button type="submit" disabled={posting} className="bg-[#262367] text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-[#35318c] transition disabled:opacity-50">
            {posting ? 'Posting...' : 'Post Announcement'}
          </button>
        </form>
      </div>

      <div className="space-y-4">
        {announcements.map(a => (
          <div key={a.id} className="bg-white rounded-2xl border border-gray-100 p-5 flex items-start justify-between shadow-sm">
            <div>
              <p className="font-bold text-gray-900">{a.title}</p>
              <p className="text-sm text-gray-600 mt-1">{a.content}</p>
              <p className="text-xs text-gray-400 mt-2">{a.created_at ? new Date(a.created_at.seconds * 1000).toLocaleString() : 'Just now'}</p>
            </div>
            <button onClick={() => handleDelete(a.id)} className="text-red-400 hover:text-red-600 p-2"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        {announcements.length === 0 && (
          <p className="text-center py-8 text-gray-400 text-sm">No announcements posted yet.</p>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CHECK-IN DESK
// ─────────────────────────────────────────────────────────────

function CheckInDesk({ bookings, updateStatus, markNoShow }) {
  const [search, setSearch] = useState('')
  const [confirming, setConfirming] = useState(null)

  const todayStr = new Date().toISOString().split('T')[0]
  const shortToday = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  function isToday(b) {
    if (b.booking_date && b.booking_date === todayStr) return true
    if (b.date && b.date.includes(shortToday)) return true
    return false
  }

  const todayBookings = bookings.filter(isToday)
  const confirmed = todayBookings.filter(b => b.status === 'Confirmed')
  const checkedIn = todayBookings.filter(b => b.status === 'Checked-In' || b.status === 'Active')

  const q = search.trim().toLowerCase()
  function matches(b) {
    if (!q) return true
    return (
      (b.student_name || b.name || '').toLowerCase().includes(q) ||
      (b.student_id || '').toLowerCase().includes(q) ||
      (b.firestoreId || '').toLowerCase().includes(q) ||
      (b.id || '').toLowerCase().includes(q)
    )
  }

  async function handleCheckIn(b) {
    setConfirming(b.firestoreId)
    await updateStatus(b.firestoreId, 'Checked-In')
    setConfirming(null)
  }

  function BookingRow({ b, done, index }) {
    return (
      <div className="flex items-center gap-4 px-5 py-3.5 border-b border-gray-100 last:border-0 hover:bg-gray-50/70 transition-colors">
        <span className="text-xs font-medium text-gray-300 w-5 text-right flex-shrink-0 tabular-nums">{index + 1}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{b.student_name || b.name || '—'}</p>
          <p className="text-[11px] text-gray-400 mt-0.5 truncate">
            ID&nbsp;{b.student_id || '—'}&ensp;·&ensp;{b.room_name || b.facility || '—'}&ensp;·&ensp;{b.time || '—'}
          </p>
        </div>
        {done ? (
          <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 flex-shrink-0">
            <CheckCircle2 size={14} />
            Checked In
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => handleCheckIn(b)}
              disabled={confirming === b.firestoreId}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#262367] text-white text-xs font-semibold hover:bg-[#35318c] disabled:opacity-50 transition-colors"
            >
              {confirming === b.firestoreId
                ? <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                : <Check size={12} />
              }
              Check In
            </button>
            <button
              onClick={() => markNoShow(b)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100 transition-colors"
            >
              No-Show
            </button>
          </div>
        )}
      </div>
    )
  }

  const filteredConfirmed = confirmed.filter(matches)
  const filteredCheckedIn = checkedIn.filter(matches)

  return (
    <div className="space-y-5">

      {/* Page header */}
      <div>
        <h2 className="text-lg font-bold text-gray-900">Check-In Desk</h2>
        <p className="text-sm text-gray-500 mt-0.5">{dateLabel}</p>
      </div>

      {/* Summary stat row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Today', value: todayBookings.length, icon: CalendarCheck },
          { label: 'Awaiting', value: confirmed.length, icon: Clock },
          { label: 'Checked In', value: checkedIn.length, icon: CheckCircle2 },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Icon size={14} className="text-gray-400" />
              <span className="text-xs font-medium text-gray-500">{label}</span>
            </div>
            <p className="text-2xl font-bold text-gray-900 tabular-nums leading-none">{value}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="text"
          placeholder="Search by name, student ID, or booking ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#262367]/20 focus:border-[#262367]/40"
        />
      </div>

      {/* Awaiting check-in */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={13} className="text-gray-400" />
            <span className="text-sm font-semibold text-gray-800">Awaiting Check-In</span>
          </div>
          <span className="text-xs font-semibold text-gray-500 tabular-nums">{filteredConfirmed.length}</span>
        </div>
        {filteredConfirmed.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-gray-400">{q ? 'No matches found.' : 'All clear — no one is waiting.'}</p>
          </div>
        ) : (
          filteredConfirmed.map((b, i) => <BookingRow key={b.firestoreId} b={b} done={false} index={i} />)
        )}
      </div>

      {/* Already checked in */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={13} className="text-gray-400" />
            <span className="text-sm font-semibold text-gray-800">Checked In</span>
          </div>
          <span className="text-xs font-semibold text-gray-500 tabular-nums">{filteredCheckedIn.length}</span>
        </div>
        {filteredCheckedIn.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-gray-400">{q ? 'No matches found.' : 'No students checked in yet today.'}</p>
          </div>
        ) : (
          filteredCheckedIn.map((b, i) => <BookingRow key={b.firestoreId} b={b} done={true} index={i} />)
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────

function Analytics({ bookings }) {
  const [users, setUsers] = useState([])
  const [period, setPeriod] = useState('30d')
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }, err => console.warn('Analytics users error:', err.message))
    return unsub
  }, [])

  const cutoff = useMemo(() => {
    if (period === 'all') return null
    const d = new Date()
    d.setDate(d.getDate() - (period === '7d' ? 7 : 30))
    d.setHours(0, 0, 0, 0)
    return d
  }, [period])

  const filtered = useMemo(() => bookings.filter(b => {
    if (!cutoff) return true
    const raw = b.booking_date || b.date || ''
    const d = raw ? new Date(raw) : null
    return d && d >= cutoff
  }), [bookings, cutoff])

  const total = filtered.length // gross records in period (used for rates + status distribution)
  const confirmed = filtered.filter(b => b.status === 'Confirmed').length
  const checkedIn = filtered.filter(b => b.status === 'Checked-In' || b.status === 'Active').length
  const noShows = filtered.filter(b => b.status === 'No-Show').length
  const cancelled = filtered.filter(b => b.status === 'Cancelled').length
  const pending = filtered.filter(b => b.status === 'Pending').length
  // Realistic "Total Bookings" = bookings that were actually made and not withdrawn.
  const realBookings = total - cancelled

  const noShowRate = total > 0 ? Math.round((noShows / total) * 100) : 0
  const cancelRate = total > 0 ? Math.round((cancelled / total) * 100) : 0
  const checkinRate = (confirmed + checkedIn) > 0 ? Math.round((checkedIn / (confirmed + checkedIn)) * 100) : 0
  const completionRate = total > 0 ? Math.round((checkedIn / total) * 100) : 0

  // Registered students = real accounts only. Rejected/declined applications are
  // NOT counted (they can't log in and are hidden from the registry).
  const students = users.filter(u => u.role === 'student' && u.status !== 'rejected')
  const activeStudents = students.filter(u => u.status === 'ACTIVE').length
  const pendingStudents = students.filter(u => u.status === 'pending').length
  const suspended = students.filter(u => u.status === 'SUSPENDED').length

  const roomMap = {}
  filtered.forEach(b => {
    const r = b.room_name || b.facility || 'Unknown'
    roomMap[r] = (roomMap[r] || 0) + 1
  })
  const roomData = Object.entries(roomMap).sort((a, b) => b[1] - a[1])

  const slotMap = {}
  filtered.forEach(b => { if (b.time) slotMap[b.time] = (slotMap[b.time] || 0) + 1 })
  const slotData = Object.entries(slotMap).sort((a, b) => b[1] - a[1])

  const deptMap = {}
  students.forEach(u => { if (u.department) deptMap[u.department] = (deptMap[u.department] || 0) + 1 })
  const deptData = Object.entries(deptMap).sort((a, b) => b[1] - a[1]).slice(0, 6)

  const last14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (13 - i))
    return d.toISOString().split('T')[0]
  })
  const dailyMap = {}
  bookings.forEach(b => { const k = b.booking_date || ''; if (k) dailyMap[k] = (dailyMap[k] || 0) + 1 })
  const trendData = last14.map(date => ({ date, count: dailyMap[date] || 0 }))
  const maxTrend = Math.max(...trendData.map(d => d.count), 1)

  const statusData = [
    { label: 'Checked-In / Active', value: checkedIn, hex: '#262367' },
    { label: 'Confirmed', value: confirmed, hex: '#3b82f6' },
    { label: 'Pending', value: pending, hex: '#f59e0b' },
    { label: 'Cancelled', value: cancelled, hex: '#9ca3af' },
    { label: 'No-Show', value: noShows, hex: '#ef4444' },
  ]
  const maxStatus = Math.max(...statusData.map(s => s.value), 1)

  // ── Sub-components ────────────────────────────────────────────

  function SectionHeader({ title, subtitle }) {
    return (
      <div className="mb-5">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
    )
  }

  function StatCard({ icon: Icon, label, value, note }) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Icon size={15} className="text-[#262367]" />
          </div>
          <span className="text-xs font-medium text-gray-500 leading-tight">{label}</span>
        </div>
        <p className="text-2xl font-bold text-gray-900 leading-none tabular-nums">{value}</p>
        {note && <p className="text-[11px] text-gray-400 mt-1.5">{note}</p>}
      </div>
    )
  }

  function BarRow({ label, value, max }) {
    const pct = max > 0 ? Math.round((value / max) * 100) : 0
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-600 truncate pr-3" style={{ maxWidth: '65%' }}>{label}</span>
          <span className="text-xs font-semibold text-gray-700 tabular-nums">{value} <span className="font-normal text-gray-400">({pct}%)</span></span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
          <div className="h-full rounded-full bg-[#262367] transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  function RateRow({ label, value, note, accent }) {
    return (
      <div className="flex items-center justify-between py-3.5 border-b border-gray-100 last:border-0">
        <div>
          <p className="text-sm font-medium text-gray-800">{label}</p>
          <p className="text-xs text-gray-400 mt-0.5">{note}</p>
        </div>
        <div className="text-right ml-4 flex-shrink-0">
          <p className={`text-xl font-bold tabular-nums ${accent}`}>{value}%</p>
          <div className="w-20 bg-gray-100 rounded-full h-1 mt-1.5 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${value}%`, backgroundColor: 'currentColor' }} />
          </div>
        </div>
      </div>
    )
  }

  // ── Bar chart (14-day trend) ──────────────────────────────────
  const BAR_H = 110
  const yTicks = [0, Math.ceil(maxTrend / 2), maxTrend]

  // ── Cyberspace data ───────────────────────────────────────────
  const csAll      = filtered.filter(b => b.cyberspace_token_hash)
  const csDone     = csAll.filter(b => b.status === 'Done')
  const csLive     = csAll.filter(b => ['Active', 'Checked-In'].includes(b.status))
  const csUnique   = new Set(csAll.map(b => b.student_id || b.user_id)).size
  const csRate     = realBookings > 0 ? Math.round((csAll.length / realBookings) * 100) : 0
  const csRoomMap  = {}; csAll.forEach(b => { const r = b.room_name || 'Unknown'; csRoomMap[r] = (csRoomMap[r] || 0) + 1 })
  const csRoomData = Object.entries(csRoomMap).sort((a, b) => b[1] - a[1])
  const csSlotMap  = {}; csAll.forEach(b => { if (b.time) csSlotMap[b.time] = (csSlotMap[b.time] || 0) + 1 })
  const csSlotData = Object.entries(csSlotMap).sort((a, b) => b[1] - a[1])
  const recentCS   = [...csAll].sort((a, b) => new Date(b.booking_date + 'T00:00') - new Date(a.booking_date + 'T00:00')).slice(0, 8)
  const CS_STATUS  = {
    Done:         { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Completed' },
    Active:       { bg: 'bg-blue-100',    text: 'text-blue-700',    label: 'Active' },
    'Checked-In': { bg: 'bg-purple-100',  text: 'text-purple-700',  label: 'In Session' },
  }

  // ── Tab definitions ───────────────────────────────────────────
  const TABS = [
    { key: 'overview',    icon: BarChart2,    label: 'Overview' },
    { key: 'bookings',    icon: CalendarCheck,label: 'Bookings' },
    { key: 'students',    icon: Users2,        label: 'Students' },
    { key: 'cyberspace',  icon: Monitor,       label: 'Cyberspace' },
  ]

  return (
    <div className="space-y-5">

      {/* ── Header row ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Analytics</h2>
          <p className="text-sm text-gray-500 mt-0.5">Facility usage, booking trends, and student activity</p>
        </div>
        {/* Period filter */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 self-start">
          {[['7d','7 Days'],['30d','30 Days'],['all','All Time']].map(([key,lbl]) => (
            <button key={key} onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all
                ${period === key ? 'bg-white text-[#262367] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(({ key, icon: Icon, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px
              ${tab === key
                ? 'border-[#262367] text-[#262367]'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}>
            <Icon size={14} />
            {label}
            {key === 'cyberspace' && csLive.length > 0 && (
              <span className="ml-1 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">{csLive.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════
          TAB: OVERVIEW
      ══════════════════════════════════════════ */}
      {tab === 'overview' && (
        <div className="space-y-4">
          {/* 4 KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={CalendarCheck} label="Total Bookings"      value={realBookings}        note={`${pending} pending · ${cancelled} cancelled`} />
            <StatCard icon={Users2}         label="Registered Students" value={students.length}      note={`${activeStudents} active · ${pendingStudents} pending`} />
            <StatCard icon={TrendingUp}     label="Check-In Rate"       value={`${checkinRate}%`}   note="Confirmed → Checked-In" />
            <StatCard icon={TrendingDown}   label="No-Show Rate"        value={`${noShowRate}%`}    note={`${noShows} no-show${noShows !== 1 ? 's' : ''} this period`} />
          </div>

          {/* Trend chart + Status */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Daily Booking Trend" subtitle="Last 14 days (all-time data)" />
              <div className="flex gap-2">
                <div className="flex flex-col justify-between text-right pr-1" style={{ height: BAR_H }}>
                  {[...yTicks].reverse().map(t => (
                    <span key={t} className="text-[10px] text-gray-400 tabular-nums leading-none">{t}</span>
                  ))}
                </div>
                <div className="flex-1 relative" style={{ height: BAR_H }}>
                  {yTicks.map((t, i) => (
                    <div key={i} className="absolute w-full border-t border-gray-100" style={{ bottom: `${(t / maxTrend) * 100}%` }} />
                  ))}
                  <div className="absolute inset-0 flex items-end gap-px">
                    {trendData.map((d, i) => {
                      const h = maxTrend > 0 ? Math.round((d.count / maxTrend) * 100) : 0
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center justify-end group relative" style={{ height: '100%' }}>
                          {d.count > 0 && (
                            <span className="absolute -top-5 text-[9px] font-semibold text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">{d.count}</span>
                          )}
                          <div className="w-full rounded-sm transition-all duration-300 bg-[#262367] opacity-80 hover:opacity-100"
                            style={{ height: `${h}%`, minHeight: d.count > 0 ? 2 : 0 }} />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div className="flex justify-between mt-2 pl-8">
                {trendData.filter((_, i) => i === 0 || i === 6 || i === 13).map(d => (
                  <span key={d.date} className="text-[10px] text-gray-400">
                    {new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                ))}
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Booking Status" subtitle="Distribution for selected period" />
              {total === 0
                ? <p className="text-sm text-gray-400 text-center py-8">No bookings in this period</p>
                : <>
                    <div className="space-y-4">
                      {statusData.map(({ label, value }) => (
                        <BarRow key={label} label={label} value={value} max={maxStatus} />
                      ))}
                    </div>
                    <div className="mt-4 flex h-1.5 rounded-full overflow-hidden gap-px">
                      {statusData.filter(s => s.value > 0).map(({ label, value, hex }) => (
                        <div key={label} className="transition-all rounded-full"
                          style={{ width: `${(value / total) * 100}%`, backgroundColor: hex }}
                          title={`${label}: ${value}`} />
                      ))}
                    </div>
                  </>
              }
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB: BOOKINGS
      ══════════════════════════════════════════ */}
      {tab === 'bookings' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Room Popularity" subtitle="Total bookings per facility" />
              {roomData.length === 0
                ? <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
                : <div className="space-y-4">{roomData.map(([r, c]) => <BarRow key={r} label={r} value={c} max={roomData[0][1]} />)}</div>
              }
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Peak Time Slots" subtitle="Most booked time windows" />
              {slotData.length === 0
                ? <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
                : <div className="space-y-4">{slotData.map(([s, c]) => <BarRow key={s} label={s} value={c} max={slotData[0][1]} />)}</div>
              }
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Engagement Rates" subtitle="Key performance indicators" />
              <RateRow label="Completion Rate"   value={completionRate} note="Bookings that reached Checked-In" accent="text-[#262367]" />
              <RateRow label="Check-In Rate"     value={checkinRate}    note="Confirmed → Checked-In"          accent="text-emerald-600" />
              <RateRow label="Cancellation Rate" value={cancelRate}     note="Bookings cancelled before use"   accent="text-amber-600" />
              <RateRow label="No-Show Rate"      value={noShowRate}     note="Confirmed but not attended"      accent="text-red-500" />
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB: STUDENTS
      ══════════════════════════════════════════ */}
      {tab === 'students' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Student Account Health" subtitle="Current status across all registered accounts" />
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Active',    value: activeStudents,  dot: '#10b981' },
                  { label: 'Pending',   value: pendingStudents, dot: '#f59e0b' },
                  { label: 'Suspended', value: suspended,       dot: '#ef4444' },
                  { label: 'Total',     value: students.length, dot: '#6b7280' },
                ].map(({ label, value, dot }) => (
                  <div key={label} className="border border-gray-100 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dot }} />
                      <span className="text-xs text-gray-500 font-medium">{label}</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900 tabular-nums leading-none">{value}</p>
                  </div>
                ))}
              </div>
              {students.length > 0 && (
                <div className="mt-4 flex h-1 rounded-full overflow-hidden gap-px">
                  <div className="bg-emerald-400 transition-all" style={{ width: `${(activeStudents / students.length) * 100}%` }} />
                  <div className="bg-amber-400  transition-all" style={{ width: `${(pendingStudents / students.length) * 100}%` }} />
                  <div className="bg-red-400    transition-all" style={{ width: `${(suspended / students.length) * 100}%` }} />
                </div>
              )}
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <SectionHeader title="Students by Department" subtitle="Registered students per college" />
              {deptData.length === 0
                ? <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
                : <div className="space-y-4">{deptData.map(([d, c]) => <BarRow key={d} label={d.replace('College of ', '')} value={c} max={deptData[0][1]} />)}</div>
              }
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB: CYBERSPACE
      ══════════════════════════════════════════ */}
      {tab === 'cyberspace' && (
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { icon: Monitor,      label: 'Total Sessions',     value: csAll.length,  note: `${csRate}% of all bookings this period` },
              { icon: CheckCircle2, label: 'Completed',          value: csDone.length, note: 'Marked Done by admin' },
              { icon: Zap,          label: 'Live Right Now',     value: csLive.length, note: 'Currently in session' },
              { icon: Users2,       label: 'Unique Students',    value: csUnique,      note: 'Distinct users who accessed' },
            ].map(({ icon: Icon, label, value, note }) => (
              <StatCard key={label} icon={Icon} label={label} value={value} note={note} />
            ))}
          </div>

          {csAll.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <Monitor size={32} className="text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-400">No Cyberspace sessions in this period</p>
              <p className="text-xs text-gray-300 mt-1">Sessions appear once an access code is issued to a student</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Sessions by room */}
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <SectionHeader title="Sessions by Room" subtitle="Which rooms are used most for Cyberspace" />
                  <div className="space-y-4">
                    {csRoomData.map(([r, c]) => <BarRow key={r} label={r} value={c} max={csRoomData[0][1]} />)}
                  </div>
                </div>

                {/* Sessions by time slot */}
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <SectionHeader title="Sessions by Time Slot" subtitle="Peak Cyberspace hours" />
                  <div className="space-y-4">
                    {csSlotData.length === 0
                      ? <p className="text-sm text-gray-400 text-center py-6">No data</p>
                      : csSlotData.map(([s, c]) => <BarRow key={s} label={s} value={c} max={csSlotData[0][1]} />)
                    }
                  </div>
                </div>

                {/* Adoption ring */}
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <SectionHeader title="Cyberspace Adoption" subtitle="Of all bookings, how many used Cyberspace" />
                  <div className="flex flex-col items-center gap-3 py-3">
                    <div className="relative w-28 h-28">
                      <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#f3f4f6" strokeWidth="3.2" />
                        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#262367" strokeWidth="3.2"
                          strokeDasharray={`${csRate} ${100 - csRate}`} strokeLinecap="round" />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-2xl font-bold text-gray-900 tabular-nums">{csRate}%</span>
                        <span className="text-[10px] text-gray-400 font-medium">adoption</span>
                      </div>
                    </div>
                    <div className="w-full space-y-2">
                      <div className="flex justify-between text-xs text-gray-500">
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#262367] inline-block" />Used Cyberspace</span>
                        <span className="font-semibold tabular-nums">{csAll.length}</span>
                      </div>
                      <div className="flex justify-between text-xs text-gray-500">
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-200 inline-block" />Room only</span>
                        <span className="font-semibold tabular-nums">{realBookings - csAll.length}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Recent sessions table */}
              {recentCS.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Recent Cyberspace Sessions</p>
                      <p className="text-xs text-gray-400 mt-0.5">Most recent first</p>
                    </div>
                    <span className="text-xs font-medium bg-[#262367]/8 text-[#262367] px-2.5 py-1 rounded-full">{csAll.length} total</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 bg-gray-50">
                          {['Student', 'Room', 'Date', 'Time Slot', 'Status'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {recentCS.map((b, i) => {
                          const meta = CS_STATUS[b.status] || { bg: 'bg-gray-100', text: 'text-gray-600', label: b.status }
                          return (
                            <tr key={b.docId || i} className="hover:bg-gray-50/60 transition-colors">
                              <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">
                                {b.student_name || '—'}
                                {b.student_id && <span className="ml-1.5 text-[11px] text-gray-400 font-normal">{b.student_id}</span>}
                              </td>
                              <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{b.room_name || '—'}</td>
                              <td className="px-4 py-3 text-gray-500 whitespace-nowrap tabular-nums">
                                {b.booking_date ? new Date(b.booking_date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                              </td>
                              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{b.time || '—'}</td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${meta.bg} ${meta.text}`}>
                                  {meta.label}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ACCOUNT SETTINGS
// ─────────────────────────────────────────────────────────────

function AccountSettings({ profile, setProfile }) {
  const [name, setName] = useState(profile?.name || 'Administrator')
  const [email, setEmail] = useState(profile?.email || 'admin@lcspace.edu.ph')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = { ...profile, name, email }
      sessionStorage.setItem('admin_user', JSON.stringify(updated))
      if (setProfile) setProfile(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-10 px-4 sm:px-6 lg:px-8 animate-in fade-in duration-300">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Account Settings</h2>
        <p className="text-sm text-gray-500 mt-1">Manage your administrative profile and preferences.</p>
      </div>

      <div className="space-y-6">
        {/* Profile Card */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm flex flex-col sm:flex-row items-center sm:items-start gap-6">
          <img
            src={`https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.name || 'Admin')}&background=F5C900&color=262367&size=80&rounded=true`}
            className="w-20 h-20 rounded-full border border-gray-200 object-cover bg-gray-50" alt="Profile"
          />
          <div className="flex-1 text-center sm:text-left">
            <h3 className="text-xl font-bold text-gray-900">{profile?.name || 'Administrator'}</h3>
            <p className="text-sm text-gray-500 font-medium">{profile?.email || 'admin@lcspace.edu.ph'}</p>
          </div>
          <div className="mt-2 sm:mt-0">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-[#262367]/10 text-[#262367]">
              System Administrator
            </span>
          </div>
        </div>

        {/* Editable Form */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
          <div className="p-6 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-gray-900 tracking-tight">Institutional Details</h3>
              <p className="text-sm text-gray-500 mt-1">Update your administrative contact details.</p>
            </div>
            {saved && (
              <div className="flex items-center gap-1.5 text-xs font-bold text-green-600 bg-green-50 px-3 py-1.5 rounded-md">
                <Check size={14} /> Changes Saved
              </div>
            )}
          </div>
          <form onSubmit={handleSave} className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mb-8">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Full Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} required
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-white focus:border-[#262367] focus:ring-1 focus:ring-[#262367] outline-none transition text-sm font-medium" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Email Address</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-white focus:border-[#262367] focus:ring-1 focus:ring-[#262367] outline-none transition text-sm font-medium" />
              </div>
            </div>

            <div className="flex justify-end pt-4 border-t border-gray-100">
              <button type="submit" disabled={saving} className="bg-[#262367] text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-[#35318c] transition shadow-sm disabled:opacity-50 flex items-center gap-2">
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// MAIL SYSTEM
// ─────────────────────────────────────────────────────────────

function AdminMail({ setAlertConfig }) {
  const [messages, setMessages] = useState([])
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [recipientType, setRecipientType] = useState('all') // 'all' | 'student'
  const [selectedStudent, setSelectedStudent] = useState(null)
  const [studentSearch, setStudentSearch] = useState('')
  const [students, setStudents] = useState([])
  const [sending, setSending] = useState(false)
  const [selected, setSelected] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [activeTab, setActiveTab] = useState('sent') // 'sent' | 'inbox'

  useEffect(() => {
    const q = query(collection(db, 'admin_messages'), orderBy('created_at', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    // Load students for recipient dropdown (exclude rejected accounts)
    getDocs(query(collection(db, 'users'), where('role', '==', 'student')))
      .then(snap => setStudents(snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.status !== 'rejected').sort((a, b) => (a.name || '').localeCompare(b.name || ''))))
      .catch(() => { })
    return unsub
  }, [])

  async function handleDeleteMessage(msgId) {
    setDeletingId(msgId)
    try {
      await deleteDoc(doc(db, 'admin_messages', msgId))
      if (selected?.id === msgId) setSelected(null)
    } catch (err) {
      console.error(err)
      setAlertConfig({ type: 'alert', title: 'Error', message: 'Failed to delete message.' })
    }
    setDeletingId(null)
  }

  async function handleSend(e) {
    e.preventDefault()
    if (!subject.trim() || !content.trim()) return
    if (recipientType === 'student' && !selectedStudent) return
    setSending(true)
    try {
      await addDoc(collection(db, 'admin_messages'), {
        subject: sanitizeText(subject),
        message: sanitizeText(content),
        direction: recipientType === 'all' ? 'to_all' : 'to_student',
        recipient_id: recipientType === 'all' ? 'all' : selectedStudent.student_id,
        recipient_uid: recipientType === 'all' ? null : selectedStudent.uid,
        recipient_name: recipientType === 'all' ? null : (selectedStudent.name || null),
        recipient_student_id: recipientType === 'all' ? null : (selectedStudent.student_id || null),
        created_at: serverTimestamp()
      })
      setSubject('')
      setContent('')
      setRecipientType('all')
      setSelectedStudent(null)
      setStudentSearch('')
      setAlertConfig({ type: 'alert', title: 'Message Sent', message: 'Your message has been delivered.' })
    } catch (err) {
      console.error(err)
      setAlertConfig({ type: 'alert', title: 'Error', message: 'Failed to send message.' })
    } finally {
      setSending(false)
    }
  }

  function fmt(ts) {
    if (!ts) return '—'
    const d = new Date(ts.seconds ? ts.seconds * 1000 : ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  // Cyberspace session invites are student-to-student — they don't belong in the admin mailbox.
  const adminMail = messages.filter(m => m.type !== 'session_invite')
  const sentMessages = adminMail.filter(m => m.direction !== 'from_student')
  const inboxMessages = adminMail.filter(m => m.direction === 'from_student')
  const tabMessages = activeTab === 'sent' ? sentMessages : inboxMessages

  const filteredStudents = studentSearch.trim()
    ? students.filter(s => (s.name || '').toLowerCase().includes(studentSearch.toLowerCase()) || (s.student_id || '').includes(studentSearch))
    : students

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-gray-900">Mail System</h2>
        <p className="text-xs text-gray-400 mt-0.5">Send messages to students and view replies.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Compose */}
        <div className="lg:col-span-2">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">New Message</h3>
            </div>
            <form onSubmit={handleSend} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Recipient</label>
                <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
                  <button type="button"
                    onClick={() => { setRecipientType('all'); setSelectedStudent(null); setStudentSearch('') }}
                    className={`flex-1 py-2 font-medium transition ${recipientType === 'all' ? 'bg-[#262367] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                    All Students
                  </button>
                  <button type="button"
                    onClick={() => setRecipientType('student')}
                    className={`flex-1 py-2 font-medium transition ${recipientType === 'student' ? 'bg-[#262367] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                    Specific Student
                  </button>
                </div>
                {recipientType === 'student' && (
                  <div className="mt-2 relative">
                    <input
                      value={studentSearch}
                      onChange={e => { setStudentSearch(e.target.value); setSelectedStudent(null) }}
                      placeholder="Search by name or student ID…"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition"
                    />
                    {studentSearch && !selectedStudent && filteredStudents.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {filteredStudents.slice(0, 20).map(s => (
                          <button key={s.uid} type="button"
                            onClick={() => { setSelectedStudent(s); setStudentSearch(`${s.name} (${s.student_id})`) }}
                            className="w-full text-left px-3 py-2.5 hover:bg-gray-50 transition border-b border-gray-100 last:border-0">
                            <p className="text-sm font-medium text-gray-900">{s.name}</p>
                            <p className="text-[11px] text-gray-500">{s.student_id}</p>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedStudent && (
                      <div className="mt-1.5 flex items-center gap-2 px-2.5 py-1.5 bg-[#262367]/5 border border-[#262367]/20 rounded-lg">
                        <span className="text-xs font-medium text-[#262367] flex-1">{selectedStudent.name} — {selectedStudent.student_id}</span>
                        <button type="button" onClick={() => { setSelectedStudent(null); setStudentSearch('') }} className="text-gray-400 hover:text-gray-600 transition"><X size={12} /></button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Subject</label>
                <input
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  required
                  placeholder="Message subject"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Message</label>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  required
                  rows={5}
                  placeholder="Write your message..."
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-[#262367] focus:border-[#262367] transition resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={sending || (recipientType === 'student' && !selectedStudent)}
                className="w-full flex items-center justify-center gap-2 bg-[#262367] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#35318c] transition disabled:opacity-50"
              >
                {sending
                  ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <><Send className="w-3.5 h-3.5" /> Send Message</>
                }
              </button>
            </form>
          </div>
        </div>

        {/* Messages panel */}
        <div className="lg:col-span-3">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
              <div className="flex gap-1">
                {[['sent', 'Sent', sentMessages.length], ['inbox', 'Inbox', inboxMessages.length]].map(([tab, label, count]) => (
                  <button key={tab} onClick={() => { setActiveTab(tab); setSelected(null) }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${activeTab === tab ? 'bg-[#262367] text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
                    {label}
                    {count > 0 && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${activeTab === tab ? 'bg-white/20' : 'bg-gray-200 text-gray-600'}`}>{count}</span>}
                  </button>
                ))}
              </div>
            </div>
            {tabMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 text-center px-6">
                <MailOpen className="w-9 h-9 text-gray-300 mb-3" />
                <p className="text-sm font-medium text-gray-600">{activeTab === 'sent' ? 'No messages sent yet' : 'No messages from students'}</p>
              </div>
            ) : selected ? (
              <div className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <button onClick={() => setSelected(null)} className="text-xs text-[#262367] hover:underline flex items-center gap-1">← Back to list</button>
                  <div className="flex items-center gap-2">
                    {selected.direction === 'from_student' && selected.sender_uid && (
                      <button
                        onClick={() => {
                          const student = students.find(s => s.uid === selected.sender_uid) || {
                            uid: selected.sender_uid,
                            name: selected.sender_name,
                            student_id: selected.sender_student_id,
                          }
                          setRecipientType('student')
                          setSelectedStudent(student)
                          setStudentSearch(`${student.name} (${student.student_id})`)
                          setSubject(selected.subject?.startsWith('Re:') ? selected.subject : `Re: ${selected.subject || ''}`)
                          setContent('')
                          setSelected(null)
                          window.scrollTo({ top: 0, behavior: 'smooth' })
                        }}
                        className="flex items-center gap-1.5 text-xs text-[#262367] border border-[#262367]/30 hover:bg-[#262367]/5 rounded-lg px-3 py-1.5 transition font-semibold"
                      >
                        <Send size={12} /> Reply
                      </button>
                    )}
                    <button onClick={() => handleDeleteMessage(selected.id)} disabled={deletingId === selected.id}
                      className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 border border-red-200 hover:bg-red-50 rounded-lg px-3 py-1.5 transition disabled:opacity-50">
                      {deletingId === selected.id ? <div className="w-3 h-3 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" /> : <Trash2 size={12} />}
                      Delete
                    </button>
                  </div>
                </div>
                <h4 className="text-base font-semibold text-gray-900 mb-1">{selected.subject}</h4>
                <div className="flex items-center gap-3 mb-4 text-xs text-gray-500">
                  {selected.direction === 'from_student'
                    ? <span>From: <span className="font-medium text-blue-700">{selected.sender_name} ({selected.sender_student_id})</span></span>
                    : <span>To: <span className={`font-medium ${selected.recipient_id === 'all' ? 'text-amber-700' : 'text-blue-700'}`}>
                      {selected.recipient_id === 'all'
                        ? 'All Students'
                        : (selected.recipient_name && selected.recipient_student_id)
                          ? `${selected.recipient_name} (${selected.recipient_student_id})`
                          : selected.recipient_id}
                    </span></span>
                  }
                  <span className="text-gray-300">·</span>
                  <span>{selected.created_at ? new Date(selected.created_at.seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</span>
                  {selected.direction !== 'from_student' && selected.recipient_id !== 'all' && (
                    <>
                      <span className="text-gray-300">·</span>
                      {selected.read
                        ? <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold">
                            <CheckCircle2 size={12} /> Seen{selected.read_at ? ` · ${new Date(selected.read_at.seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
                          </span>
                        : <span className="inline-flex items-center gap-1 text-gray-400 font-medium"><Check size={12} /> Delivered</span>}
                    </>
                  )}
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed break-all">{selected.message}</p>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto">
                {tabMessages.map(m => (
                  <div key={m.id} onClick={() => {
                      setSelected(m)
                      // Mark a student's message read so their Sent shows "Seen by admin"
                      if (m.direction === 'from_student' && !m.read) {
                        updateDoc(doc(db, 'admin_messages', m.id), { read: true, read_at: serverTimestamp() }).catch(() => { })
                      }
                    }}
                    className="group w-full text-left px-5 py-4 hover:bg-gray-50 transition cursor-pointer flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-[#262367]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      {m.direction === 'from_student' ? <Mail size={13} className="text-green-600" /> : m.recipient_id === 'all' ? <Megaphone size={13} className="text-[#262367]" /> : <Mail size={13} className="text-[#262367]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">{m.subject}</span>
                        <span className="text-[11px] text-gray-400 flex-shrink-0">{fmt(m.created_at)}</span>
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5">{m.message?.substring(0, 70)}{m.message?.length > 70 ? '…' : ''}</p>
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        {m.direction === 'from_student'
                          ? <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border bg-green-50 text-green-700 border-green-200">{m.sender_name} ({m.sender_student_id})</span>
                          : <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${m.recipient_id === 'all' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
                            {m.recipient_id === 'all'
                              ? 'Broadcast'
                              : (m.recipient_name ? `${m.recipient_name} (${m.recipient_student_id || m.recipient_id})` : m.recipient_id)}
                          </span>
                        }
                        {m.direction !== 'from_student' && m.recipient_id !== 'all' && (
                          m.read
                            ? <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600"><CheckCircle2 size={11} /> Seen</span>
                            : <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-400"><Check size={11} /> Delivered</span>
                        )}
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); handleDeleteMessage(m.id) }} disabled={deletingId === m.id}
                      className="opacity-0 group-hover:opacity-100 transition flex-shrink-0 mt-0.5 p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 disabled:opacity-50" title="Delete">
                      {deletingId === m.id ? <div className="w-3.5 h-3.5 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// HELP TICKETS
// ─────────────────────────────────────────────────────────────

function AdminHelp({ setAlertConfig }) {
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    const q = query(collection(db, 'help_tickets'), orderBy('created_at', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    }, err => { console.error(err); setLoading(false) })
    return unsub
  }, [])

  async function handleResolve(id) {
    setAlertConfig({
      type: 'confirm',
      title: 'Mark as Resolved',
      message: 'Mark this support ticket as resolved?',
      onConfirm: async () => {
        try { await updateDoc(doc(db, 'help_tickets', id), { status: 'Resolved' }) }
        catch (err) { console.error(err) }
      }
    })
  }

  async function handleDelete(id) {
    setAlertConfig({
      type: 'confirm',
      title: 'Delete Ticket',
      message: 'Permanently delete this support ticket? This cannot be undone.',
      onConfirm: async () => {
        try { await deleteDoc(doc(db, 'help_tickets', id)) }
        catch (err) { console.error(err) }
      }
    })
  }

  const stats = {
    total: tickets.length,
    open: tickets.filter(t => t.status !== 'Resolved').length,
    resolved: tickets.filter(t => t.status === 'Resolved').length,
  }

  const filtered = filter === 'open'
    ? tickets.filter(t => t.status !== 'Resolved')
    : filter === 'resolved'
      ? tickets.filter(t => t.status === 'Resolved')
      : tickets

  function fmt(ts) {
    if (!ts) return '—'
    return new Date(ts.seconds ? ts.seconds * 1000 : ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-gray-900">Help Tickets</h2>
        <p className="text-xs text-gray-400 mt-0.5">Review and resolve student support requests.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total', value: stats.total, f: 'all', textColor: 'text-gray-900' },
          { label: 'Open', value: stats.open, f: 'open', textColor: 'text-amber-600' },
          { label: 'Resolved', value: stats.resolved, f: 'resolved', textColor: 'text-green-600' },
        ].map(({ label, value, f, textColor }) => (
          <button
            key={label}
            onClick={() => setFilter(f)}
            className={`bg-white border rounded-xl px-5 py-4 text-left transition ${filter === f ? 'border-[#262367] ring-1 ring-[#262367]' : 'border-gray-200 hover:border-gray-300'}`}
          >
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold ${textColor}`}>{value}</p>
          </button>
        ))}
      </div>

      {/* Ticket list */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            {filter === 'all' ? 'All Tickets' : filter === 'open' ? 'Open Tickets' : 'Resolved Tickets'}
          </h3>
          <span className="text-xs text-gray-400">{filtered.length} shown</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="w-5 h-5 border-2 border-[#262367]/20 border-t-[#262367] rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center px-6">
            <CheckCircle2 className="w-9 h-9 text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-600">No {filter === 'all' ? '' : filter} tickets</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {filtered.map(t => (
              <div key={t.id} className={`px-6 py-5 transition ${t.status !== 'Resolved' ? 'hover:bg-gray-50/60' : 'bg-gray-50/40'}`}>
                <div className="flex items-start gap-4">
                  <img
                    src={`https://ui-avatars.com/api/?name=${encodeURIComponent(t.student_name || 'S')}&background=F5C900&color=262367&size=40&rounded=true`}
                    className={`w-9 h-9 rounded-full border border-gray-200 flex-shrink-0 ${t.status === 'Resolved' ? 'opacity-50' : ''}`}
                    alt=""
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3 mb-0.5">
                      <div>
                        <p className={`text-sm font-semibold leading-snug ${t.status === 'Resolved' ? 'text-gray-500' : 'text-gray-900'}`}>{t.subject}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                          <span className="font-medium text-gray-600">{t.student_name}</span>
                          <span>·</span>
                          <span className="font-mono">{t.student_id}</span>
                          <span>·</span>
                          <span>{fmt(t.created_at)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${t.status === 'Resolved'
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}>
                          {t.status === 'Resolved' ? 'Resolved' : 'Open'}
                        </span>
                        {t.status !== 'Resolved' && (
                          <button
                            onClick={() => handleResolve(t.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-semibold transition"
                          >
                            <Check className="w-3 h-3" /> Resolve
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(t.id)}
                          title="Delete ticket"
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-semibold transition"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </div>
                    <p className={`mt-2 text-sm leading-relaxed px-3 py-2.5 rounded-lg border ${t.status === 'Resolved' ? 'text-gray-400 bg-gray-50 border-gray-100' : 'text-gray-600 bg-gray-50 border-gray-100'}`}>
                      {t.message}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CYBERSPACE ACCESS
// ─────────────────────────────────────────────────────────────
function PasswordMigration() {
  const [status, setStatus] = useState('idle') // idle | running | done | error
  const [log, setLog] = useState([])
  const [counts, setCounts] = useState({ migrated: 0, skipped: 0, errors: 0 })

  async function runMigration() {
    setStatus('running')
    setLog([])
    const result = { migrated: 0, skipped: 0, errors: 0 }

    try {
      const snap = await getDocs(collection(db, 'users'))
      const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
      setLog(prev => [...prev, `Found ${users.length} user documents.`])

      for (const user of users) {
        if (!user.student_password) {
          result.skipped++
          continue
        }
        try {
          // Write to student_credentials/{uid}
          await setDoc(doc(db, 'student_credentials', user.uid), {
            password: user.student_password,
          }, { merge: true })

          // Remove student_password from user doc
          await updateDoc(doc(db, 'users', user.uid), { student_password: deleteField() })

          setLog(prev => [...prev, `✓ Migrated: ${user.student_id || user.email || user.uid}`])
          result.migrated++
        } catch (e) {
          setLog(prev => [...prev, `✗ Error for ${user.uid}: ${e.message}`])
          result.errors++
        }
      }

      setCounts(result)
      setLog(prev => [...prev, `Done — ${result.migrated} migrated, ${result.skipped} skipped (no password), ${result.errors} errors.`])
      setStatus('done')
    } catch (e) {
      setLog(prev => [...prev, `Fatal error: ${e.message}`])
      setStatus('error')
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
      <div>
        <p className="text-sm font-bold text-gray-800">One-Time Password Migration</p>
        <p className="text-xs text-gray-500 mt-1">Moves student passwords stored in the <code className="bg-gray-100 px-1 rounded text-[11px]">users</code> collection into the secure <code className="bg-gray-100 px-1 rounded text-[11px]">student_credentials</code> collection. Run this once, then this card can be removed.</p>
      </div>

      {status === 'idle' && (
        <button onClick={runMigration}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#262367] hover:bg-[#35318c] text-white rounded-xl text-xs font-bold transition">
          <Key size={13} /> Run Migration
        </button>
      )}

      {status === 'running' && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <div className="w-3.5 h-3.5 border-2 border-[#262367]/30 border-t-[#262367] rounded-full animate-spin flex-shrink-0" />
          Migrating…
        </div>
      )}

      {log.length > 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 max-h-48 overflow-y-auto font-mono text-[11px] text-gray-600 space-y-0.5">
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}

      {status === 'done' && (
        <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-100 rounded-xl text-xs text-green-700">
          <Check size={13} /> Migration complete — {counts.migrated} passwords moved to <code className="bg-green-100 px-1 rounded">student_credentials</code>.
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-700">
          <AlertCircle size={13} /> Migration failed. Check the log above.
        </div>
      )}
    </div>
  )
}

function CyberspaceAccess() {
  const [tokens, setTokens] = useState([])
  const [regeneratingId, setRegeneratingId] = useState(null)
  const todayStr = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    const q = query(collection(db, 'cyberspace_tokens'), where('date', '==', todayStr))
    const unsub = onSnapshot(q, async snap => {
      const list = snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }))
      // Filter out tokens for cancelled, finished, or no-show bookings
      const checked = await Promise.all(
        list.map(async t => {
          try {
            const bSnap = await getDoc(doc(db, 'bookings', t.firestoreId))
            const data = bSnap.data()
            const status = data?.status
            if (!bSnap.exists() || status === 'Cancelled' || status === 'Done' || status === 'No-Show') {
              deleteDoc(doc(db, 'cyberspace_tokens', t.firestoreId)).catch(() => { })
              return null
            }
            // Attach the student's SELECTED reservation date from the live booking.
            return { ...t, _resDate: data?.booking_date || data?.date || null }
          } catch { return null }
        })
      )
      const valid = checked.filter(Boolean)
      valid.sort((a, b) => (a.student_name || '').localeCompare(b.student_name || ''))
      setTokens(valid)
    }, () => { })
    return unsub
  }, [todayStr])

  async function regenerate(t) {
    setRegeneratingId(t.firestoreId)
    try {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let token = ''
      for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)]
      const hash = await sha256(token)
      await Promise.all([
        setDoc(doc(db, 'cyberspace_tokens', t.firestoreId), { ...t, token, created_at: serverTimestamp() }),
        updateDoc(doc(db, 'bookings', t.firestoreId), { cyberspace_token_hash: hash }),
      ])
    } catch (err) {
      console.error('Regenerate failed:', err.message)
    }
    setRegeneratingId(null)
  }

  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const fmtResDate = (d) => {
    if (!d) return ''
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d)
    return isNaN(parsed) ? d : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Cyberspace Access</h2>
        <p className="text-sm text-gray-500 mt-1">Each confirmed booking gets a unique access code. Students must visit this desk to receive their individual code.</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-5">
        <div className="flex items-start gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
          <Monitor className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-blue-700 leading-relaxed">
            <strong>How it works:</strong> When you confirm a student's booking, a unique 6-character code is automatically generated for them. It is visible only here — students cannot see it in the app. When a student visits the desk, find their name below and read out their code. Use the refresh button if a student needs a new code.
          </p>
        </div>

        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Today's Access Codes — {dateLabel}</p>
          {tokens.length === 0 ? (
            <div className="px-4 py-8 border border-dashed border-gray-200 rounded-xl text-center">
              <p className="text-sm text-gray-400">No confirmed bookings for today yet.</p>
              <p className="text-xs text-gray-400 mt-1">Codes appear here automatically when you confirm a booking from the Command Center.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {tokens.map(t => (
                <div key={t.firestoreId} className="flex items-center gap-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-800 truncate">{t.student_name}</p>
                    <p className="text-[11px] text-gray-500 truncate">{t.student_id}{t._resDate ? ` · ${fmtResDate(t._resDate)}` : ''}{t.room_name ? ` · ${t.room_name}` : ''}{t.time ? ` · ${t.time}` : ''}</p>
                  </div>
                  <span className="font-mono text-base font-bold tracking-widest text-[#262367] bg-[#262367]/10 px-3 py-1.5 rounded-lg flex-shrink-0 select-all">
                    {t.token}
                  </span>
                  <button
                    onClick={() => regenerate(t)}
                    disabled={regeneratingId === t.firestoreId}
                    title="Regenerate code"
                    className="p-2 text-gray-400 hover:text-[#262367] hover:bg-[#262367]/10 rounded-lg transition disabled:opacity-50 flex-shrink-0">
                    {regeneratingId === t.firestoreId
                      ? <div className="w-3.5 h-3.5 border-2 border-gray-300 border-t-[#262367] rounded-full animate-spin" />
                      : <RotateCcw size={14} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <p className="text-sm font-bold text-gray-800 mb-3">Admin Workflow</p>
        <ol className="space-y-2.5">
          {[
            "Confirm a student's pending booking — their unique code is generated automatically.",
            "When the student visits the desk, find their name in Today's Access Codes above.",
            'Verify their booking and check them in.',
            'Read out their unique code. Do not share other students\' codes.',
            'If a student loses or forgets their code, use the refresh button to generate a new one.',
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-xs text-gray-600">
              <span className="w-5 h-5 rounded-full bg-[#262367]/10 text-[#262367] text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </div>

      <PasswordMigration />
    </div>
  )
}
