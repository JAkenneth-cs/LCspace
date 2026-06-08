import AgoraRTC from 'agora-rtc-sdk-ng'
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import { useEffect, useRef, useState, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import {
  collection, query, where, orderBy, getDocs, doc, getDoc,
  setDoc, addDoc, deleteDoc, onSnapshot, serverTimestamp
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { sanitizeText } from '../lib/validation'
import {
  Mic, MicOff, Camera, CameraOff, ScreenShare, ScreenShareOff,
  PhoneOff, PenLine, Eraser, ChevronLeft, Users, Clock, Trash2,
  UserPlus, MessageSquare, Send, X, UserX,
  Check, AlertCircle, FlipHorizontal2, LayoutGrid, Maximize2, AlignJustify,
  Pin, PinOff, WifiOff, Type
} from 'lucide-react'

// ── Agora RTC (managed cloud SFU — handles NAT/TURN/relay automatically) ─────
const AGORA_APP_ID = import.meta.env.VITE_AGORA_APP_ID
const AGORA_APP_CERTIFICATE = import.meta.env.VITE_AGORA_APP_CERTIFICATE || ''

function buildAgoraToken(channelName, uid) {
  if (!AGORA_APP_CERTIFICATE) return null
  const expiry = Math.floor(Date.now() / 1000) + 3600
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID, AGORA_APP_CERTIFICATE, channelName, uid, RtcRole.PUBLISHER, expiry, expiry
  )
}

// Map Firebase string UID → stable Agora numeric UID (consistent across sessions)
function hashToAgoraUid(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0
  }
  return (Math.abs(h) % 999998) + 1 // 1 – 999999
}


const COLORS = ['#1e1b4b', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#000000', '#ffffff']

// TEMP (testing): bypass the session time-window gate and auto-termination so the
// session can be entered/tested any time. Set back to false to restore normal rules.
const CYBERSPACE_TEST_MODE = true

// Parses '8:00 AM – 10:00 AM' into { startMs, endMs } for a given date
function parseTimeSlot(slotStr, dateStr) {
  if (!slotStr) return null
  const parts = slotStr.replace(/–|—|‒/g, '-').split('-').map(s => s.trim())
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

const fmtChatTime = ts => {
  if (!ts) return 'just now'
  const date = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts)
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

const fmtTimeRemaining = secs => {
  if (secs === null || secs === undefined) return null
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function VideoTile({ stream, name, isLocal, onRemove, cameraOn, isSpotlight, compact, mirror, onMirror, onClick, remoteMicOn, remoteCameraOn, isPinned, onPin, isReconnecting, localMicOn, coverFill }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el || !stream) return
    if (el.srcObject === stream) return
    el.srcObject = stream
    el.play().catch(err => {
      if (err.name !== 'AbortError') console.warn(`[VideoTile] play error for ${name}:`, err.message)
    })
  }, [stream, name])

  const initial = (name || '?')[0].toUpperCase()
  const showAvatar = !isReconnecting && (!stream || (isLocal && !cameraOn) || (!isLocal && remoteCameraOn === false))
  // Mic-off: explicit false only (undefined = unknown, treat as on)
  const micOff = isLocal ? localMicOn === false : remoteMicOn === false
  const camOff = isLocal ? !cameraOn : remoteCameraOn === false

  return (
    <div
      onClick={onClick}
      className={`group relative overflow-hidden bg-[#111827] flex items-center justify-center transition-all duration-300 shadow-2xl ${isSpotlight ? '' : 'rounded-2xl'}
        ${onClick ? 'cursor-pointer' : ''}
        ${isReconnecting
          ? 'ring-2 ring-amber-400/60'
          : isPinned && !isSpotlight
            ? 'ring-2 ring-[#2563eb]/60'
            : isLocal && !isSpotlight
              ? 'ring-2 ring-blue-500/50'
              : isSpotlight
                ? 'ring-0'
                : 'ring-1 ring-white/8 hover:ring-white/20'}
        ${isSpotlight ? 'w-full h-full aspect-auto' : compact ? 'h-full aspect-video' : 'w-full h-full aspect-video'}`}
    >
      <video
        ref={videoRef}
        autoPlay playsInline muted={true}
        style={mirror ? { transform: 'scaleX(-1)' } : undefined}
        className={`w-full h-full transition-opacity duration-500 ${isSpotlight ? (coverFill ? 'object-cover' : 'object-contain') : 'object-cover'} ${showAvatar ? 'opacity-0' : 'opacity-100'}`}
      />

      {/* Mirror toggle — local tile only, top-right corner */}
      {onMirror && (
        <button
          onClick={e => { e.stopPropagation(); onMirror() }}
          title={mirror ? 'Show original' : 'Mirror camera'}
          className="absolute top-3 right-3 z-30 p-2 rounded-xl bg-black/55 backdrop-blur-md text-white/60 hover:text-white hover:bg-black/75 transition-all opacity-0 group-hover:opacity-100 border border-white/10"
        >
          <FlipHorizontal2 size={13} />
        </button>
      )}

      {/* Pin / Unpin — local: top-left, remote: top-right */}
      {onPin && (
        <button
          onClick={e => { e.stopPropagation(); onPin() }}
          title={isPinned ? 'Unpin' : 'Pin to focus'}
          className={`absolute top-3 z-30 p-2 rounded-xl backdrop-blur-md transition-all border
            ${isLocal ? 'left-3' : onMirror ? 'left-3' : 'right-3'}
            ${isPinned
              ? 'bg-[#2563eb]/30 border-[#2563eb]/50 text-[#2563eb]'
              : 'bg-black/55 border-white/10 text-white/60 hover:text-white hover:bg-black/75 opacity-0 group-hover:opacity-100'
            }`}
        >
          {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      )}

      {/* Reconnecting overlay */}
      {isReconnecting && (
        <div className="absolute inset-0 z-20 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
          <div className="w-9 h-9 border-2 border-white/15 border-t-amber-400 rounded-full animate-spin" />
          <div className="text-center">
            <p className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">Reconnecting…</p>
            <p className="text-[9px] text-white/30 mt-0.5">Please wait</p>
          </div>
        </div>
      )}

      {/* Camera-off avatar */}
      {showAvatar && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0f1923] to-[#090e15] z-10 gap-3 animate-in fade-in duration-300">
          <div className={`${compact ? 'w-11 h-11 text-xl' : 'w-[4.5rem] h-[4.5rem] sm:w-24 sm:h-24 text-3xl sm:text-5xl'} rounded-full bg-gradient-to-br from-[#1e3a8a] via-[#1d4ed8] to-[#3b82f6] flex items-center justify-center shadow-xl ring-4 ring-white/5 font-black text-white`}>
            {initial}
          </div>
          {!compact && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08]">
              <CameraOff size={10} className="text-orange-400" />
              <span className="text-[9px] text-white/50 font-bold uppercase tracking-widest">Camera Off</span>
            </div>
          )}
        </div>
      )}

      {/* Bottom gradient scrim for label readability */}
      {!showAvatar && (
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-black/75 via-black/30 to-transparent pointer-events-none z-10" />
      )}

      {/* Bottom label — name + mic/cam status (Google Meet style) */}
      <div className="absolute bottom-0 left-0 right-0 px-3 pb-3 flex items-end justify-between z-20 pointer-events-none">
        <div className="flex items-center gap-1.5 bg-black/55 backdrop-blur-md border border-white/[0.08] rounded-xl px-2.5 py-1.5 max-w-[calc(100%-3rem)]">
          {/* Live status dot */}
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isLocal ? 'bg-blue-400 animate-pulse' : 'bg-green-400'}`} />

          {/* Name */}
          <span className="text-[11px] font-semibold text-white/90 truncate leading-none">
            {name}{isLocal ? ' (You)' : ''}
          </span>

          {/* Mic-off indicator — shows for both local and remote */}
          {micOff && (
            <div className="flex-shrink-0 bg-red-500/20 rounded-md p-0.5">
              <MicOff size={10} className="text-red-400" />
            </div>
          )}

          {/* Camera-off indicator — shows in compact/thumbnail strip */}
          {compact && camOff && !micOff && (
            <div className="flex-shrink-0 bg-orange-500/20 rounded-md p-0.5">
              <CameraOff size={10} className="text-orange-400" />
            </div>
          )}

          {/* Pin indicator */}
          {isPinned && <Pin size={8} className="text-[#2563eb] flex-shrink-0" />}
        </div>

        {onRemove && (
          <button
            onClick={e => { e.stopPropagation(); onRemove() }}
            className="pointer-events-auto p-2 rounded-xl bg-red-500/80 hover:bg-red-500 text-white transition-colors"
          >
            <UserX size={13} />
          </button>
        )}
      </div>

      {/* Connecting indicator */}
      {!isLocal && !stream && !isReconnecting && (
        <div className="absolute top-3 left-3 z-30">
          <div className="bg-emerald-500/15 backdrop-blur-md border border-emerald-500/20 rounded-lg px-2 py-1 flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wide">Connecting…</span>
          </div>
        </div>
      )}
    </div>
  )
}

function CtrlBtn({ onClick, active, danger, disabled, title, children, badge, dot }) {
  return (
    <div className="relative">
      <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed
          ${danger
            ? 'bg-red-500 hover:bg-red-600 shadow-xl shadow-red-500/20 text-white'
            : active === false
              ? 'bg-white/5 border border-white/[0.06] text-white/35 hover:bg-white/8 hover:text-white/55'
              : 'bg-white/5 border border-white/10 hover:bg-white/10 text-white/80 active:scale-90 hover:-translate-y-0.5'
          }`}
      >
        {children}
      </button>
      {badge > 0 && (
        <span className="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-[#0d1520]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {dot && !badge && (
        <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-amber-400 rounded-full animate-pulse ring-2 ring-[#0d1520]" />
      )}
    </div>
  )
}


export default function Session() {
  const navigate = useNavigate()
  const location = useLocation()
  const inviteSessionId = useMemo(
    () => new URLSearchParams(location.search).get('invite'),
    [location.search]
  )

  const canvasRef = useRef(null)
  const unsubsRef = useRef([])
  const sessionIdRef = useRef('NEX-0000')
  const myUidRef = useRef(null)
  const myNameRef = useRef('')
  const joinTimeRef = useRef(0)
  const strokeRef = useRef([])
  const chatBottomRef = useRef(null)
  // Agora
  const localStreamRef = useRef(null)
  const agoraClientRef = useRef(null)
  const localAudioTrackRef = useRef(null)
  const localVideoTrackRef = useRef(null)
  const screenVideoTrackRef = useRef(null)
  const agoraToFirebaseRef = useRef({}) // agoraUid (number) → firebaseUid (string)
  // Notification tracking — refs stay current inside Firestore listener closures
  const showChatRef = useRef(false)
  const showWhiteboardRef = useRef(false)
  const lastSeenChatCountRef = useRef(0)

  const [drawing, setDrawing] = useState(false)
  const [showWhiteboard, setShowWhiteboard] = useState(false)
  const [tool, setTool] = useState('pen')
  const [textPos, setTextPos] = useState(null)   // { x, y, px, py } — where text input appears
  const [textInput, setTextInput] = useState('')
  const [fontSize, setFontSize] = useState(20)
  const textInputRef = useRef(null)
  const [color, setColor] = useState('#1e1b4b')
  const [lastPos, setLastPos] = useState(null)

  const [sessionInfo, setSessionInfo] = useState({ room_name: 'USPF Cyberspace', time: '10:00 AM – 12:00 PM', id: 'NEX-0000' })
  const [myName, setMyName] = useState('')
  const [myUid, setMyUid] = useState(null)
  const [isGuest, setIsGuest] = useState(false)
  const [participants, setParticipants] = useState([])
  // Whiteboard draw permissions: { [uid]: { status: 'requested' | 'granted', name } }
  const [drawGrants, setDrawGrants] = useState({})
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState({}) // uid → MediaStream
  const [screenSharing, setScreenSharing] = useState(false)
  const [screenStream, setScreenStream] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [mediaError, setMediaError] = useState(null)
  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  // True once a REAL booking/invite session has loaded (not the placeholder default).
  // Guards the auto-termination monitor so the default time never triggers it.
  const [sessionReady, setSessionReady] = useState(false)

  // Chat
  const [showChat, setShowChat] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [unreadChat, setUnreadChat] = useState(0)
  const [whiteboardAlert, setWhiteboardAlert] = useState(false)
  const [mirrorLocal, setMirrorLocal] = useState(true) // mirrored by default like a selfie cam
  const [layout, setLayout] = useState('grid')          // 'grid' | 'spotlight' | 'strip'
  const [spotlightUid, setSpotlightUid] = useState(null) // null = auto (first remote peer)
  const [pinnedUid, setPinnedUid] = useState(null)       // uid of pinned participant (local or remote)
  const [timeRemaining, setTimeRemaining] = useState(null) // seconds remaining in session
  const [isOffline, setIsOffline] = useState(!navigator.onLine)

  // Invite & Participants
  const [showParticipants, setShowParticipants] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteInput, setInviteInput] = useState('')
  const [inviteStatus, setInviteStatus] = useState(null)
  const [inviteLoading, setInviteLoading] = useState(false)

  // Replay whiteboard history whenever the panel opens (canvas is remounted each time)
  useEffect(() => {
    if (showWhiteboard) redrawFromHistory()
  }, [showWhiteboard])

  // Keep notification refs in sync and clear indicators when panels open
  useEffect(() => {
    showChatRef.current = showChat
    if (showChat) {
      setUnreadChat(0)
      lastSeenChatCountRef.current = chatMessages.length
    }
  }, [showChat, chatMessages.length])

  useEffect(() => {
    showWhiteboardRef.current = showWhiteboard
    if (showWhiteboard) setWhiteboardAlert(false)
  }, [showWhiteboard])

  // Session countdown timer — updates every second so participants see time left
  useEffect(() => {
    if (!sessionReady || !sessionInfo?.time || CYBERSPACE_TEST_MODE) return
    const slot = parseTimeSlot(sessionInfo.time, sessionInfo.date)
    if (!slot) return
    const update = () => setTimeRemaining(Math.max(0, Math.floor((slot.endMs - Date.now()) / 1000)))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [sessionReady, sessionInfo])

  // Network offline/online detection
  useEffect(() => {
    const onOnline  = () => setIsOffline(false)
    const onOffline = () => setIsOffline(true)
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // Clear pin automatically when the pinned peer leaves the session
  useEffect(() => {
    if (!pinnedUid || pinnedUid === myUid) return
    if (!participants.find(p => p.uid === pinnedUid)) setPinnedUid(null)
  }, [participants, pinnedUid, myUid])

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // Load user + booking (or invite)
  useEffect(() => {
    const dev = JSON.parse(sessionStorage.getItem('dev_user') || 'null')
    if (dev) {
      const b = JSON.parse(localStorage.getItem('lcspace_bookings_v1') || '[]')
        .find(b => b.status === 'Checked-In' || b.status === 'Confirmed')
      if (b) { setSessionInfo(b); sessionIdRef.current = b.id; setSessionReady(true) }
      const name = dev.name || 'Guest'
      myNameRef.current = name
      setMyName(name)
      myUidRef.current = `dev_${name.replace(/\s+/g, '_').toLowerCase()}`
      setMyUid(myUidRef.current)
      return
    }
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) { navigate('/'); return }
      myUidRef.current = user.uid
      setMyUid(user.uid)
      const snap = await getDoc(doc(db, 'users', user.uid))
      if (!snap.exists()) return
      const data = snap.data()
      const name = data.name || 'Student'
      myNameRef.current = name
      setMyName(name)

      // TEST MODE: with no invite link, put everyone in ONE shared room so testers
      // always meet (and presence/chat/media line up). Remove with CYBERSPACE_TEST_MODE.
      if (CYBERSPACE_TEST_MODE && !inviteSessionId) {
        setSessionInfo({ id: 'TEST-LOBBY', room_name: 'Test Lobby', time: sessionInfo.time, date: null })
        sessionIdRef.current = 'TEST-LOBBY'
        setSessionReady(true)
        return
      }

      // Check for invite param — bypasses booking requirement
      if (inviteSessionId) {
        try {
          const inviteDoc = await getDoc(doc(db, 'sessions', inviteSessionId, 'invites', user.uid))
          if (inviteDoc.exists()) {
            const inv = inviteDoc.data()
            const info = { id: inviteSessionId, room_name: inv.room_name, time: inv.time, date: inv.date }
            setSessionInfo(info)
            sessionIdRef.current = inviteSessionId
            setIsGuest(true)
            setSessionReady(true)
            return
          }
        } catch (e) {
          console.warn('Invite lookup failed:', e.message)
        }
      }

      // Regular booking lookup
      const q = query(
        collection(db, 'bookings'),
        where('student_id', '==', data.student_id),
        where('status', 'in', ['Confirmed', 'Checked-In'])
      )
      const bSnap = await getDocs(q)
      if (!bSnap.empty) {
        const bk = bSnap.docs[0].data()
        const info = { id: bk.id || bSnap.docs[0].id, room_name: bk.room_name, time: bk.time, date: bk.booking_date }
        setSessionInfo(info)
        sessionIdRef.current = info.id
        setSessionReady(true)
      }
    })
    return unsub
  }, [navigate, inviteSessionId])

  // Init canvas + preserve content on resize.
  // Re-runs whenever the whiteboard popup opens (the canvas is mounted only then),
  // and replays existing strokes from Firestore so prior drawings reappear.
  useEffect(() => {
    if (!showWhiteboard) return
    const canvas = canvasRef.current
    if (!canvas) return
    function syncSize() {
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      if (!w || !h) return
      const tmp = document.createElement('canvas')
      tmp.width = canvas.width || w
      tmp.height = canvas.height || h
      tmp.getContext('2d').drawImage(canvas, 0, 0)
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      if (tmp.width > 0 && tmp.height > 0) {
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, w, h)
      }
    }
    syncSize()
    redrawFromHistory()
    const ro = new ResizeObserver(syncSize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [showWhiteboard])

  // Session termination monitor — only runs against a REAL loaded session,
  // never the placeholder default (which would falsely fire after 12:00 PM).
  useEffect(() => {
    if (!sessionReady || !sessionInfo?.time) return
    const slot = parseTimeSlot(sessionInfo.time, sessionInfo.date)
    if (!slot) return

    let interval
    const check = async () => {
      if (CYBERSPACE_TEST_MODE) return // testing: never auto-terminate
      const remaining = slot.endMs - Date.now()
      if (remaining <= 0) {
        clearInterval(interval)
        await showAlert('Session Ended', 'This session has officially ended.')
        navigate('/dashboard')
      }
    }

    check()
    interval = setInterval(check, 10000) // check every 10s
    return () => clearInterval(interval)
  }, [sessionReady, sessionInfo, navigate])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      teardownAgora()
      unsubsRef.current.forEach(fn => fn())
    }
  }, [])


  // ─── Whiteboard Sync ─────────────────────────────────────

  function drawStroke({ points, color: c, width: w }) {
    if (!points || points.length < 2) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.beginPath()
    ctx.moveTo(points[0].x * W, points[0].y * H)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * W, points[i].y * H)
    ctx.strokeStyle = c
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  // Focus the text textarea whenever it mounts (textPos becomes non-null)
  useEffect(() => {
    if (textPos) {
      const t = setTimeout(() => textInputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [textPos])

  function drawTextItem({ text, x, y, color: c, fontSize: fs }) {
    const canvas = canvasRef.current
    if (!canvas || !text) return
    const ctx = canvas.getContext('2d')
    ctx.font = `${fs || 20}px sans-serif`
    ctx.fillStyle = c || '#000000'
    ctx.fillText(text, x * canvas.width, y * canvas.height)
  }

  function clearCanvasLocal() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  function listenWhiteboard(sid) {
    const since = Date.now() // only alert for strokes added after we joined
    const u = onSnapshot(
      query(collection(db, 'sessions', sid, 'whiteboard'), orderBy('ts')),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type !== 'added') return
          const data = change.doc.data()
          if (data.type === 'clear') {
            clearCanvasLocal()
          } else if (data.drawn_by !== myUidRef.current) {
            if (data.type === 'stroke') drawStroke(data)
            else if (data.type === 'text') drawTextItem(data)
            if ((data.type === 'stroke' || data.type === 'text') && !showWhiteboardRef.current && (data.ts || 0) > since) {
              setWhiteboardAlert(true)
            }
          }
        })
      }
    )
    unsubsRef.current.push(u)
  }

  async function saveStroke(points) {
    if (!points || points.length < 2) return
    const sid = sessionIdRef.current
    await addDoc(collection(db, 'sessions', sid, 'whiteboard'), {
      type: 'stroke',
      points,
      color: tool === 'eraser' ? '#ffffff' : color,
      width: tool === 'eraser' ? 24 : 3,
      drawn_by: myUidRef.current,
      ts: Date.now(),
    })
  }

  async function clearWhiteboard() {
    clearCanvasLocal()
    const sid = sessionIdRef.current
    await addDoc(collection(db, 'sessions', sid, 'whiteboard'), {
      type: 'clear',
      drawn_by: myUidRef.current,
      ts: Date.now(),
    })
  }

  // Replay the full board from Firestore (used when the popup (re)opens, since
  // the canvas is unmounted while closed and loses any strokes drawn meanwhile).
  async function redrawFromHistory() {
    const sid = sessionIdRef.current
    if (!sid) return
    try {
      const snap = await getDocs(query(collection(db, 'sessions', sid, 'whiteboard'), orderBy('ts')))
      const docs = snap.docs.map(d => d.data())
      clearCanvasLocal()
      // Start after the most recent 'clear' marker
      let start = 0
      for (let i = docs.length - 1; i >= 0; i--) {
        if (docs[i].type === 'clear') { start = i + 1; break }
      }
      for (let i = start; i < docs.length; i++) {
        if (docs[i].type === 'stroke') drawStroke(docs[i])
        else if (docs[i].type === 'text') drawTextItem(docs[i])
      }
    } catch (e) {
      console.warn('Whiteboard redraw failed:', e.message)
    }
  }

  // ─── Chat ────────────────────────────────────────────────

  function listenChat(sid) {
    const u = onSnapshot(
      query(collection(db, 'sessions', sid, 'chat'), orderBy('ts')),
      (snap) => {
        // Only show messages from THIS session (sent after you joined) so old
        // chat history from previous sessions in the same room isn't shown.
        const since = joinTimeRef.current - 10000 // small buffer for clock skew
        const msgs = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(m => !m.ts?.seconds || m.ts.seconds * 1000 >= since)
        if (showChatRef.current) {
          lastSeenChatCountRef.current = msgs.length
        } else if (msgs.length > lastSeenChatCountRef.current) {
          setUnreadChat(msgs.length - lastSeenChatCountRef.current)
        }
        setChatMessages(msgs)
      },
      err => console.warn('Chat listen error:', err.message)
    )
    unsubsRef.current.push(u)
  }

  async function sendChat(e) {
    e.preventDefault()
    const chatText = sanitizeText(chatInput.trim()).slice(0, 1000)
    if (!chatText || !joined || chatSending) return
    setChatSending(true)
    try {
      await addDoc(collection(db, 'sessions', sessionIdRef.current, 'chat'), {
        uid: myUidRef.current,
        name: sanitizeText(myNameRef.current).slice(0, 100),
        text: chatText,
        ts: serverTimestamp(),
      })
      setChatInput('')
    } catch (err) {
      console.warn('Chat send error:', err.message)
    }
    setChatSending(false)
  }

  // ─── Invite ──────────────────────────────────────────────

  async function handleInvite(e) {
    e.preventDefault()
    const rawId = inviteInput.trim()
    if (!rawId) return
    // Only allow digits and dashes (student ID format: 21-00123)
    if (!/^[\d-]+$/.test(rawId) || rawId.length > 20) {
      setInviteStatus({ type: 'error', text: 'Invalid student ID format.' })
      return
    }
    setInviteLoading(true)
    setInviteStatus(null)
    try {
      const q = query(collection(db, 'users'), where('student_id', '==', rawId))
      const snap = await getDocs(q)
      if (snap.empty) {
        setInviteStatus({ type: 'error', text: 'Student ID not found. Ensure they are registered.' })
        setInviteLoading(false)
        return
      }
      const studentDoc = snap.docs[0]
      const studentUid = studentDoc.id
      const studentData = studentDoc.data()
      const sid = sessionIdRef.current

      await setDoc(doc(db, 'sessions', sid, 'invites', studentUid), {
        host_uid: myUidRef.current,
        host_name: myNameRef.current,
        room_name: sessionInfo.room_name,
        time: sessionInfo.time,
        date: sessionInfo.date,
        invited_at: serverTimestamp(),
      })
      // Clear any pre-existing removal marker so the re-invited student
      // isn't still blocked from the previous session.
      try { await deleteDoc(doc(db, 'sessions', sid, 'removed', studentUid)) } catch { /* noop */ }

      await addDoc(collection(db, 'admin_messages'), {
        type: 'session_invite',
        recipient_uid: studentUid,
        subject: `Cyberspace Invitation — ${sessionInfo.room_name}`,
        message: `${myNameRef.current || 'A student'} has invited you to join a Cyberspace session in ${sessionInfo.room_name} (${sessionInfo.date || 'Today'} · ${sessionInfo.time}).`,
        session_id: sid,
        session_room: sessionInfo.room_name,
        session_time: sessionInfo.time,
        session_date: sessionInfo.date,
        host_name: myNameRef.current || 'Host',
        created_at: serverTimestamp(),
      })

      setInviteStatus({ type: 'success', text: `Invited ${studentData.name || rawId}.` })
      setInviteInput('')
    } catch (err) {
      console.error(err)
      setInviteStatus({ type: 'error', text: 'Failed to send invitation.' })
    }
    setInviteLoading(false)
  }

  // ─── Agora helpers ───────────────────────────────────────

  function showConfirm(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
      setDialog({
        type: danger ? 'danger' : 'confirm',
        title, message, confirmLabel,
        onConfirm: () => { setDialog(null); resolve(true) },
        onCancel: () => { setDialog(null); resolve(false) },
      })
    })
  }

  function showAlert(title, message, { confirmLabel = 'OK' } = {}) {
    return new Promise(resolve => {
      setDialog({
        type: 'info',
        title, message, confirmLabel,
        onConfirm: () => { setDialog(null); resolve() },
      })
    })
  }

  async function startAgora(sid, myUid) {
    const agoraUid = hashToAgoraUid(myUid)
    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' })
    agoraClientRef.current = client

    // MUST register event handlers BEFORE client.join() — Agora fires user-published
    // for already-present users immediately on join; handlers registered after join
    // miss those events and remote streams are never received.
    client.on('user-published', async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType)
      } catch (e) {
        // Only tolerate "already subscribed" (pre-join loop beat us to it).
        // Any other failure means we have no valid track — bail out.
        const hasTrack = mediaType === 'video' ? !!user.videoTrack : !!user.audioTrack
        if (!hasTrack) { console.warn('[Agora] subscribe failed, no track:', e); return }
      }
      const firebaseUid = agoraToFirebaseRef.current[user.uid]
      if (mediaType === 'video' && user.videoTrack) {
        const stream = new MediaStream([user.videoTrack.getMediaStreamTrack()])
        setRemoteStreams(prev => ({ ...prev, [firebaseUid || String(user.uid)]: stream }))
      }
      if (mediaType === 'audio' && user.audioTrack) user.audioTrack.play()
    })
    client.on('user-unpublished', async (user, mediaType) => {
      // SDK v4.5+ no longer auto-unsubscribes on user-unpublished — must be explicit.
      // Without this the old track subscription lingers, causing the next
      // user-published (e.g. screen share after camera) to fail with "already subscribed"
      // and leave a stale ended track in place of the new stream.
      try { await client.unsubscribe(user, mediaType) } catch { /* track may already be gone */ }
      if (mediaType === 'video') {
        const firebaseUid = agoraToFirebaseRef.current[user.uid]
        setRemoteStreams(prev => { const n = { ...prev }; delete n[firebaseUid || String(user.uid)]; return n })
      }
    })
    client.on('user-left', (user) => {
      const firebaseUid = agoraToFirebaseRef.current[user.uid]
      setRemoteStreams(prev => { const n = { ...prev }; delete n[firebaseUid || String(user.uid)]; return n })
      if (firebaseUid) delete agoraToFirebaseRef.current[user.uid]
    })

    const audioTrack = await AgoraRTC.createMicrophoneAudioTrack()
    const videoTrack = await AgoraRTC.createCameraVideoTrack()
    localAudioTrackRef.current = audioTrack
    localVideoTrackRef.current = videoTrack
    const token = buildAgoraToken(sid, agoraUid)
    await client.join(AGORA_APP_ID, sid, token, agoraUid)

    // Subscribe to users who were already publishing when we joined.
    // Video and audio use separate try/catch so a video failure never silently
    // skips audio (they share a single catch block in the old code).
    for (const remoteUser of client.remoteUsers) {
      if (remoteUser.hasVideo && !remoteUser.videoTrack) {
        try {
          await client.subscribe(remoteUser, 'video')
          const fbUid = agoraToFirebaseRef.current[remoteUser.uid]
          const stream = new MediaStream([remoteUser.videoTrack.getMediaStreamTrack()])
          setRemoteStreams(prev => ({ ...prev, [fbUid || String(remoteUser.uid)]: stream }))
        } catch (e) {
          console.warn('[Agora] pre-join video subscribe failed for uid', remoteUser.uid, e)
        }
      }
      if (remoteUser.hasAudio && !remoteUser.audioTrack) {
        try {
          await client.subscribe(remoteUser, 'audio')
          if (remoteUser.audioTrack) remoteUser.audioTrack.play()
        } catch (e) {
          console.warn('[Agora] pre-join audio subscribe failed for uid', remoteUser.uid, e)
        }
      }
    }

    await client.publish([audioTrack, videoTrack])
    // Create local stream AFTER publish so the track pipeline is fully active
    const localStream = new MediaStream([videoTrack.getMediaStreamTrack()])
    localStreamRef.current = localStream
    setLocalStream(localStream)

    const presenceUnsub = onSnapshot(collection(db, 'sessions', sid, 'presence'), (snap) => {
      snap.docChanges().forEach((change) => {
        const peerUid = change.doc.id
        if (peerUid === myUid) return
        const peerData = change.doc.data()
        if (change.type === 'added') {
          if (peerData.agoraUid) {
            agoraToFirebaseRef.current[peerData.agoraUid] = peerUid
            // Remap any stream stored under the numeric Agora UID key
            const tmpKey = String(peerData.agoraUid)
            setRemoteStreams(prev => {
              if (!prev[tmpKey]) return prev
              const n = { ...prev }
              n[peerUid] = n[tmpKey]
              delete n[tmpKey]
              return n
            })
          }
          setParticipants(prev =>
            prev.some(p => p.uid === peerUid) ? prev : [...prev, {
              uid: peerUid, name: peerData.name || 'Student',
              micOn: peerData.micOn !== false, cameraOn: peerData.cameraOn !== false,
            }]
          )
          // Definitive safety-net: now that we know agoraUid → firebaseUid, pull the
          // peer's tracks directly from client.remoteUsers so the stream always lands
          // under the Firebase UID key regardless of user-published / remap timing.
          if (peerData.agoraUid) {
            const cl = agoraClientRef.current
            const agoraUser = cl?.remoteUsers?.find(u => u.uid === peerData.agoraUid)
            if (agoraUser) {
              // Video — already subscribed: store stream; not yet: subscribe then store
              if (agoraUser.videoTrack) {
                const stream = new MediaStream([agoraUser.videoTrack.getMediaStreamTrack()])
                setRemoteStreams(prev => ({ ...prev, [peerUid]: stream }))
              } else if (agoraUser.hasVideo) {
                cl.subscribe(agoraUser, 'video')
                  .then(() => {
                    if (agoraUser.videoTrack) {
                      const stream = new MediaStream([agoraUser.videoTrack.getMediaStreamTrack()])
                      setRemoteStreams(prev => ({ ...prev, [peerUid]: stream }))
                    }
                  })
                  .catch(e => console.warn('[Agora] presence video subscribe:', e))
              }
              // Audio — same pattern
              if (agoraUser.audioTrack) {
                agoraUser.audioTrack.play()
              } else if (agoraUser.hasAudio) {
                cl.subscribe(agoraUser, 'audio')
                  .then(() => { if (agoraUser.audioTrack) agoraUser.audioTrack.play() })
                  .catch(e => console.warn('[Agora] presence audio subscribe:', e))
              }
            }
          }
        }
        if (change.type === 'modified') {
          setParticipants(prev => prev.map(p =>
            p.uid === peerUid ? { ...p, micOn: peerData.micOn !== false, cameraOn: peerData.cameraOn !== false } : p
          ))
        }
        if (change.type === 'removed') {
          if (peerData.agoraUid) delete agoraToFirebaseRef.current[peerData.agoraUid]
          setParticipants(prev => prev.filter(p => p.uid !== peerUid))
          setRemoteStreams(prev => { const n = { ...prev }; delete n[peerUid]; return n })
        }
      })
    })
    unsubsRef.current.push(presenceUnsub)
  }

  async function teardownAgora() {
    if (screenVideoTrackRef.current) {
      await agoraClientRef.current?.unpublish(screenVideoTrackRef.current).catch(() => {})
      screenVideoTrackRef.current.stop()
      screenVideoTrackRef.current.close()
      screenVideoTrackRef.current = null
      setScreenStream(null)
      setScreenSharing(false)
    }
    if (localAudioTrackRef.current) {
      localAudioTrackRef.current.stop()
      localAudioTrackRef.current.close()
      localAudioTrackRef.current = null
    }
    if (localVideoTrackRef.current) {
      localVideoTrackRef.current.stop()
      localVideoTrackRef.current.close()
      localVideoTrackRef.current = null
    }
    localStreamRef.current = null
    setLocalStream(null)
    if (agoraClientRef.current) {
      await agoraClientRef.current.leave().catch(() => {})
      agoraClientRef.current = null
    }
    setRemoteStreams({})
    agoraToFirebaseRef.current = {}
  }

  function toggleMic() {
    const track = localAudioTrackRef.current
    if (!track) return
    const newMicOn = !micOn
    track.setEnabled(newMicOn)
    setMicOn(newMicOn)
    const sid = sessionIdRef.current
    const uid = myUidRef.current
    if (sid && uid) setDoc(doc(db, 'sessions', sid, 'presence', uid), { micOn: newMicOn }, { merge: true }).catch(() => {})
  }

  async function toggleCamera() {
    const client = agoraClientRef.current
    const track = localVideoTrackRef.current
    if (!client || !track) return
    const newCameraOn = !cameraOn
    const sid = sessionIdRef.current
    const uid = myUidRef.current

    if (!newCameraOn) {
      track.setEnabled(false)
      setCameraOn(false)
    } else {
      // Close the stale disabled track and create a brand-new camera track so
      // the MediaStreamTrack is guaranteed to be live (setEnabled re-enable can
      // leave the underlying track producing no frames on some browsers).
      await client.unpublish(track).catch(() => {})
      track.close()
      try {
        const newTrack = await AgoraRTC.createCameraVideoTrack()
        localVideoTrackRef.current = newTrack
        await client.publish(newTrack).catch(() => {})
        const freshStream = new MediaStream([newTrack.getMediaStreamTrack()])
        localStreamRef.current = freshStream
        setLocalStream(freshStream)
        setCameraOn(true)
      } catch (err) {
        console.warn('[Camera] restart failed:', err)
        setCameraOn(false)
      }
    }

    if (sid && uid) setDoc(doc(db, 'sessions', sid, 'presence', uid), { cameraOn: newCameraOn }, { merge: true }).catch(() => {})
  }

  async function toggleScreenShare() {
    const client = agoraClientRef.current
    if (!client) return
    if (screenSharing) {
      if (screenVideoTrackRef.current) {
        await client.unpublish(screenVideoTrackRef.current).catch(() => {})
        screenVideoTrackRef.current.stop()
        screenVideoTrackRef.current.close()
        screenVideoTrackRef.current = null
      }
      if (localVideoTrackRef.current) await client.publish(localVideoTrackRef.current).catch(() => {})
      setScreenStream(null)
      setScreenSharing(false)
    } else {
      try {
        const screenTrack = await AgoraRTC.createScreenVideoTrack({}, 'disable')
        screenVideoTrackRef.current = screenTrack
        if (localVideoTrackRef.current) await client.unpublish(localVideoTrackRef.current).catch(() => {})
        await client.publish(screenTrack)
        const screenMediaStream = new MediaStream([screenTrack.getMediaStreamTrack()])
        setScreenStream(screenMediaStream)
        setScreenSharing(true)
        screenTrack.on('track-ended', async () => {
          await client.unpublish(screenTrack).catch(() => {})
          screenTrack.stop()
          screenTrack.close()
          screenVideoTrackRef.current = null
          if (localVideoTrackRef.current) await client.publish(localVideoTrackRef.current).catch(() => {})
          setScreenStream(null)
          setScreenSharing(false)
        })
      } catch { /* user cancelled */ }
    }
  }

  // ─── Session Join / Leave ────────────────────────────────

  async function joinRoom() {
    if (joining || joined) return
    setJoining(true)
    setMediaError(null)

    // Time gate — enforced for both booked students and invited guests
    if (!CYBERSPACE_TEST_MODE && sessionInfo.time) {
      const slot = parseTimeSlot(sessionInfo.time, sessionInfo.date)
      if (slot) {
        const nowMs = Date.now()
        if (nowMs < slot.startMs) {
          const diff = slot.startMs - nowMs
          const mins = Math.ceil(diff / 60000)
          const hrs = Math.floor(mins / 60)
          const rem = mins % 60
          const countdown = hrs > 0 ? `${hrs}h ${rem}m` : `${mins} min`
          setMediaError(`Session hasn't started yet — begins in ~${countdown}.`)
          setJoining(false)
          return
        }
        if (nowMs > slot.endMs) {
          setMediaError('This session has already ended.')
          setJoining(false)
          return
        }
      }
    }

    // ── Session-state gate ──────────────────────────────────────
    // Must run BEFORE the removal check so that stale data from a previous
    // session is cleaned up before it can block a guest from joining.
    let sessionReopenedAt = null  // tracks when the host last reopened the room
    try {
      const stateRef = doc(db, 'sessions', sessionIdRef.current, 'state', 'main')
      const stateSnap = await getDoc(stateRef)
      const stateData = stateSnap.exists() ? stateSnap.data() : {}
      const ended = stateData.ended === true

      if (ended && inviteSessionId) {
        setMediaError('This session has ended — the host has closed the room.')
        setJoining(false)
        return
      }
      if (ended && !inviteSessionId) {
        // Host is reopening the room — reset state and purge ALL stale data.
        await setDoc(stateRef, { ended: false, reopened_at: serverTimestamp() }, { merge: true })
        const sid = sessionIdRef.current
        try {
          const oldPresence = await getDocs(collection(db, 'sessions', sid, 'presence'))
          await Promise.all(oldPresence.docs.map(d => deleteDoc(d.ref)))
        } catch { /* non-fatal */ }
        try {
          const oldRemoved = await getDocs(collection(db, 'sessions', sid, 'removed'))
          await Promise.all(oldRemoved.docs.map(d => deleteDoc(d.ref)))
        } catch { /* non-fatal */ }
        try {
          const oldCalls = await getDocs(collection(db, 'sessions', sid, 'calls'))
          await Promise.all(oldCalls.docs.map(async (callDoc) => {
            const callerCands = await getDocs(collection(callDoc.ref, 'callerCandidates'))
            const calleeCands = await getDocs(collection(callDoc.ref, 'calleeCandidates'))
            await Promise.all([...callerCands.docs, ...calleeCands.docs].map(d => deleteDoc(d.ref)))
            await deleteDoc(callDoc.ref)
          }))
        } catch { /* non-fatal */ }
        // After cleanup, all removed docs are gone — no need to check further.
        sessionReopenedAt = Date.now()  // approximate; exact value is in Firestore
      } else {
        // Session never ended, or was previously reopened — grab the reopen timestamp.
        if (stateData.reopened_at) {
          sessionReopenedAt = stateData.reopened_at.seconds
            ? stateData.reopened_at.seconds * 1000
            : stateData.reopened_at
        }
      }
    } catch { /* non-fatal */ }

    // ── Removal check ─────────────────────────────────────────
    // If a removal marker exists, compare its timestamp against the session's
    // last reopen time. Removals from before the reopen are stale leftovers
    // from a previous session and should be auto-deleted.
    try {
      const removedRef = doc(db, 'sessions', sessionIdRef.current, 'removed', myUidRef.current)
      const removedSnap = await getDoc(removedRef)
      if (removedSnap.exists()) {
        const removedData = removedSnap.data()
        const removedAtMs = removedData?.at?.seconds
          ? removedData.at.seconds * 1000
          : (removedData?.at || 0)

        // Determine whether this removal is stale (left over from a previous session).
        // It's stale if:
        //   • The host explicitly reopened AFTER the removal, OR
        //   • There's no reopened_at timestamp yet (pre-fix Firestore data).
        //     Since ended sessions bail out earlier, reaching this point means
        //     the session is active — so any old removal marker is stale.
        const isStale = sessionReopenedAt
          ? removedAtMs < sessionReopenedAt
          : true  // no reopen tracking yet → treat all old markers as stale

        if (isStale) {
          try { await deleteDoc(removedRef) } catch { /* non-fatal */ }
        } else {
          // Current-session removal — block the student.
          setMediaError('You were removed from this session by the host.')
          setJoining(false)
          return
        }
      }
    } catch { /* non-fatal */ }

    const sid = sessionIdRef.current
    const uid = myUidRef.current
    const name = myNameRef.current

    // Get camera/mic and connect via Agora before showing the call UI.
    try {
      await startAgora(sid, uid)
    } catch (err) {
      console.error('[Agora] startAgora failed:', err)
      const isMediaErr = err?.code === 'PERMISSION_DENIED' || err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
      setMediaError(isMediaErr
        ? 'Could not access camera or microphone. Check browser permissions.'
        : `Connection failed: ${err?.message || err?.code || String(err)}`)
      setJoining(false)
      return
    }

    joinTimeRef.current = Date.now()
    setJoined(true)

    await setDoc(doc(db, 'sessions', sid, 'presence', uid), {
      name, uid, joined_at: serverTimestamp(), micOn: true, cameraOn: true,
      agoraUid: hashToAgoraUid(uid),
    })

    // Reset my whiteboard permission on (re)join so each session starts fresh
    // (guests must request draw access again each time).
    try { await deleteDoc(doc(db, 'sessions', sid, 'wb_access', uid)) } catch { /* noop */ }

    const u3 = onSnapshot(doc(db, 'sessions', sid, 'removed', uid), (snap) => {
      if (snap.exists()) handleRemoved()
    })

    // Guests get kicked out when the host ends the session
    if (inviteSessionId) {
      const stateUnsub = onSnapshot(doc(db, 'sessions', sid, 'state', 'main'), async (snap) => {
        if (snap.exists() && snap.data().ended === true) {
          teardownAgora()
          unsubsRef.current.forEach(fn => fn())
          unsubsRef.current = []
          try { await deleteDoc(doc(db, 'sessions', sid, 'presence', uid)) } catch { }
          await showAlert('Session Ended', 'The host has ended this session.')
          navigate('/dashboard')
        }
      })
      unsubsRef.current.push(stateUnsub)
    }

    // Whiteboard draw-permission requests/grants (host approves guests).
    const u4 = onSnapshot(collection(db, 'sessions', sid, 'wb_access'), (snap) => {
      const m = {}
      snap.docs.forEach(d => { m[d.id] = d.data() })
      setDrawGrants(m)
    }, () => { })
    unsubsRef.current.push(u4)

    unsubsRef.current.push(u3)
    listenWhiteboard(sid)
    listenChat(sid)

    setJoining(false)
  }

  // ─── Host: remove a participant ──────────────────────────
  async function removeParticipant(uid, name) {
    if (!isHost || !uid) return
    const confirmed = await showConfirm(
      'Remove Participant',
      `Remove ${name || 'this participant'} from this session?`,
      { confirmLabel: 'Remove', danger: true }
    )
    if (!confirmed) return
    const sid = sessionIdRef.current
    try {
      // Marker so the removed student is ejected in real time and can't silently re-join.
      await setDoc(doc(db, 'sessions', sid, 'removed', uid), {
        by: myNameRef.current || 'Host',
        at: serverTimestamp(),
      })
      // Drop their presence so every client removes their tile.
      await deleteDoc(doc(db, 'sessions', sid, 'presence', uid))
    } catch (e) {
      console.warn('Remove participant failed:', e.message)
    }
    // Clean up participants state.
    setParticipants(prev => prev.filter(p => p.uid !== uid))
  }

  // Called on the removed student's side when the host ejects them.
  async function handleRemoved() {
    teardownAgora()
    unsubsRef.current.forEach(fn => fn())
    unsubsRef.current = []
    const sid = sessionIdRef.current
    const uid = myUidRef.current
    if (uid) try { await deleteDoc(doc(db, 'sessions', sid, 'presence', uid)) } catch { }
    await showAlert('Removed from Session', 'The host has removed you from this session.')
    navigate('/dashboard')
  }

  async function leaveSession() {
    teardownAgora()
    unsubsRef.current.forEach(fn => fn())
    unsubsRef.current = []
    const sid = sessionIdRef.current
    const uid = myUidRef.current

    if (isHost && sid) {
      // Mark session as ended, then delete ALL stale subcollection data so
      // the next session starts completely clean.
      try { await setDoc(doc(db, 'sessions', sid, 'state', 'main'), { ended: true, ended_at: serverTimestamp() }) } catch { }
      try {
        const presenceSnap = await getDocs(collection(db, 'sessions', sid, 'presence'))
        await Promise.all(presenceSnap.docs.map(d => deleteDoc(d.ref)))
      } catch { }
      // Clear removal markers so previously-removed guests aren't blocked
      // if the host starts a new session on the same room.
      try {
        const removedSnap = await getDocs(collection(db, 'sessions', sid, 'removed'))
        await Promise.all(removedSnap.docs.map(d => deleteDoc(d.ref)))
      } catch { }
      // Delete stale WebRTC call docs + ICE candidates to prevent
      // leftover signaling data from corrupting the next session.
      try {
        const callsSnap = await getDocs(collection(db, 'sessions', sid, 'calls'))
        await Promise.all(callsSnap.docs.map(async (callDoc) => {
          const callerCands = await getDocs(collection(callDoc.ref, 'callerCandidates'))
          const calleeCands = await getDocs(collection(callDoc.ref, 'calleeCandidates'))
          await Promise.all([...callerCands.docs, ...calleeCands.docs].map(d => deleteDoc(d.ref)))
          await deleteDoc(callDoc.ref)
        }))
      } catch { }
    } else {
      if (uid) try { await deleteDoc(doc(db, 'sessions', sid, 'presence', uid)) } catch { }
    }

    setParticipants([])
    setDrawGrants({})
    setMicOn(true)
    setCameraOn(true)
    setShowWhiteboard(false)
    setJoined(false)
  }

  // ─── Whiteboard draw permission (host approves guests) ───────────────────
  async function requestDrawAccess() {
    if (!myUidRef.current) return
    try {
      await setDoc(doc(db, 'sessions', sessionIdRef.current, 'wb_access', myUidRef.current), {
        status: 'requested', name: myNameRef.current || 'Student', ts: Date.now(),
      })
    } catch (e) { console.warn('Request draw failed:', e.message) }
  }
  async function grantDrawAccess(uid) {
    try {
      await setDoc(doc(db, 'sessions', sessionIdRef.current, 'wb_access', uid), {
        status: 'granted', by: myNameRef.current || 'Host', ts: Date.now(),
      }, { merge: true })
    } catch (e) { console.warn('Grant draw failed:', e.message) }
  }
  async function denyDrawAccess(uid) {
    try { await deleteDoc(doc(db, 'sessions', sessionIdRef.current, 'wb_access', uid)) }
    catch (e) { console.warn('Deny draw failed:', e.message) }
  }

  // Mic / camera / screen-share are handled inside ZegoCloud's own in-call toolbar.

  // ─── Canvas Drawing ──────────────────────────────────────

  // Returns NORMALIZED coordinates (0–1) relative to the canvas, so strokes
  // sync correctly between users whose canvases are different pixel sizes.
  function getPos(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const src = e.touches ? e.touches[0] : e
    return {
      x: (src.clientX - rect.left) / rect.width,
      y: (src.clientY - rect.top) / rect.height,
    }
  }

  async function confirmText() {
    const txt = sanitizeText(textInput.trim()).slice(0, 500)
    if (!txt || !textPos) { setTextPos(null); setTextInput(''); return }
    drawTextItem({ text: txt, x: textPos.x, y: textPos.y, color, fontSize })
    setTextPos(null)
    setTextInput('')
    const sid = sessionIdRef.current
    await addDoc(collection(db, 'sessions', sid, 'whiteboard'), {
      type: 'text',
      text: txt,
      x: textPos.x,
      y: textPos.y,
      color,
      fontSize,
      drawn_by: myUidRef.current,
      ts: Date.now(),
    })
  }

  function startDraw(e) {
    if (!canDraw) return
    if (tool === 'text') {
      // If text input already open, confirm it first
      if (textPos && textInput.trim()) confirmText()
      const canvas = canvasRef.current
      const rect = canvas.getBoundingClientRect()
      const src = e.touches ? e.touches[0] : e
      const px = src.clientX - rect.left
      const py = src.clientY - rect.top
      setTextPos({ x: px / rect.width, y: py / rect.height, px, py })
      setTextInput('')
      return
    }
    const pos = getPos(e)
    strokeRef.current = [pos]
    setDrawing(true)
    setLastPos(pos)
  }

  function draw(e) {
    if (!drawing || !canDraw) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const pos = getPos(e)
    ctx.beginPath()
    ctx.moveTo(lastPos.x * canvas.width, lastPos.y * canvas.height)
    ctx.lineTo(pos.x * canvas.width, pos.y * canvas.height)
    ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color
    ctx.lineWidth = tool === 'eraser' ? 24 : 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
    strokeRef.current.push(pos)
    setLastPos(pos)
  }

  async function stopDraw() {
    if (!drawing) return
    setDrawing(false)
    setLastPos(null)
    if (strokeRef.current.length >= 2) {
      await saveStroke([...strokeRef.current])
    }
    strokeRef.current = []
  }

  // ─── Render ──────────────────────────────────────────────

  // True when running inside the React Native WebView shell
  const isMobile = typeof window !== 'undefined' && !!window.__LCSPACE_MOBILE
  const tileCompact = showWhiteboard && joined
  const tileCols = isMobile ? 'grid-cols-1'
    : participants.length === 0 ? 'grid-cols-1'
      : participants.length <= 3 ? 'grid-cols-2'
        : participants.length <= 8 ? 'grid-cols-3' : 'grid-cols-4'

  // Spotlight layout helpers
  // Who is in the main spotlight slot? Prefer the pinned UID, fall back to first remote peer.
  const spotlightPeer = spotlightUid
    ? (participants.find(p => p.uid === spotlightUid) ?? participants[0])
    : participants[0]
  const spotlightStream = spotlightPeer ? remoteStreams[spotlightPeer.uid] : null
  const spotlightName   = spotlightPeer?.name ?? myName
  const stripPeers = spotlightPeer
    ? participants.filter(p => p.uid !== spotlightPeer.uid)
    : participants

  // Host = the booking owner. The owner reaches the room through their own
  // booking (isGuest stays false); invited students always join via an invite
  // link (isGuest === true) and so are never the host. The host can draw on the
  // whiteboard, approve guests' draw requests, and end the session for everyone.
  const isHost = !!myUid && !isGuest
  const hostUid = isHost ? myUid : null
  const myGrantStatus = drawGrants[myUid]?.status
  const canDraw = isHost || myGrantStatus === 'granted'
  // Pending draw requests the host can approve (exclude the host's own entry).
  const pendingDraws = Object.entries(drawGrants)
    .filter(([uid, v]) => v?.status === 'requested' && uid !== hostUid)
    .map(([uid, v]) => ({ uid, name: v.name || 'Student' }))

  // Pin helpers
  const isPinnedLocal = pinnedUid === myUid
  const pinnedPeer    = pinnedUid && !isPinnedLocal ? participants.find(p => p.uid === pinnedUid) ?? null : null

  return (
    <div className="flex flex-col bg-[#0b111a] text-white overflow-hidden select-none" style={{ height: '100dvh' }}>

      {/* ── Top Bar — hidden on mobile (native header takes its place) ── */}
      <header className={`h-12 flex-shrink-0 flex items-center justify-between px-4 border-b border-white/[0.07] bg-[#0d1520]/80 backdrop-blur-xl ${isMobile ? 'hidden' : ''}`}>
        <div className="flex items-center gap-3">
          {!joined && (
            <>
              <button
                onClick={() => navigate('/dashboard')}
                className="flex items-center gap-1 text-white/30 hover:text-white transition text-xs font-medium"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>
              <div className="w-px h-4 bg-white/10" />
            </>
          )}

          {/* LCspace · USPF brand mark */}
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-black text-white tracking-tight leading-none">LC<span className="text-[#eab308]">space</span></span>
            <div className="flex flex-col leading-none">
              <span className="text-[9px] font-bold text-white/70 uppercase tracking-wider">USPF</span>
              <span className="text-[7px] text-white/30 tracking-wide">Cyberspace</span>
            </div>
          </div>

          <div className="w-px h-4 bg-white/10" />

          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shadow-lg shadow-green-400/50" />
            <span className="text-xs font-semibold text-white/80">{sessionInfo.room_name}</span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20 tracking-wide uppercase">Live</span>
            {isGuest && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20 tracking-wide uppercase">Guest</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-white/30">
          {isHost && joined && (
            <span className="px-2 py-0.5 rounded-full bg-[#eab308]/15 text-[#eab308] border border-[#eab308]/30 text-[9px] font-bold uppercase tracking-wide">
              Host
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Users className="w-3 h-3" />
            {participants.length + 1}
          </span>
          {timeRemaining !== null ? (
            <span className={`flex items-center gap-1.5 font-mono tabular-nums font-bold transition-colors
              ${timeRemaining < 120 ? 'text-red-400 animate-pulse' : timeRemaining < 600 ? 'text-amber-400' : 'text-white/30'}`}>
              <Clock className="w-3 h-3 flex-shrink-0" />
              {fmtTimeRemaining(timeRemaining)} left
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              {sessionInfo.time}
            </span>
          )}
          <span className="font-mono bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-md text-white/20 text-[10px]">
            {sessionInfo.id}
          </span>
        </div>
      </header>

      {/* ── Offline banner ── */}
      {isOffline && (
        <div className="flex-shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
          <WifiOff size={14} className="text-amber-400 flex-shrink-0" />
          <span className="text-xs font-bold text-amber-400">You're offline — video and chat are paused.</span>
          <span className="text-xs text-amber-400/60 ml-1">Reconnecting automatically…</span>
        </div>
      )}

      {/* ── Main ── */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* ── Video area + overlays ── */}
        <div className={`${showWhiteboard && joined ? 'h-56 sm:h-64 flex-shrink-0' : 'flex-1 min-h-0'} relative overflow-hidden`}>

          {/* Center Stage - Hybrid Layout System */}
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#070b11] p-4 sm:p-8 overflow-hidden transition-all duration-500">
            {!joined ? (
              <div className="text-center animate-in fade-in scale-in-95 duration-700 max-w-lg mx-auto w-full px-6">
                <div className="relative group perspective">
                  <div className={`${isMobile ? 'w-20 h-20 rounded-[2rem] mb-5' : 'w-32 h-32 rounded-[3.5rem] mb-8'} bg-gradient-to-br from-[#1e3a8a] to-[#1e3a5f] border border-white/20 flex items-center justify-center mx-auto shadow-[0_32px_64px_-16px_rgba(0,0,0,0.5)]`}>
                    <Users size={isMobile ? 32 : 48} className="text-[#2563eb]" />
                  </div>
                </div>

                <h1 className={`${isMobile ? 'text-2xl mb-1' : 'text-4xl mb-2'} font-black text-white tracking-tight leading-none`}>{sessionInfo.room_name}</h1>
                <div className={`flex items-center justify-center gap-2 ${isMobile ? 'mb-6' : 'mb-12'}`}>
                  <span className="text-[10px] text-white/25 font-black uppercase tracking-[0.3em]">LC<span className="text-[#2563eb]/60">space</span></span>
                  <span className="text-[10px] text-white/10">·</span>
                  <span className="text-[10px] text-white/25 font-bold uppercase tracking-[0.3em]">USPF Cyberspace</span>
                </div>

                <div className="space-y-4">
                  {mediaError && (
                    <div className="mx-auto p-4 rounded-3xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold leading-relaxed shadow-xl animate-in shake duration-500">
                      {mediaError}
                    </div>
                  )}

                  <div className="flex flex-col items-center gap-4">
                    <button
                      onClick={joinRoom}
                      disabled={joining}
                      className="group relative w-full px-10 py-4 rounded-[2rem] bg-white text-[#0b111a] text-base font-black transition-all active:scale-95 disabled:opacity-50 overflow-hidden shadow-[0_20px_50px_rgba(255,255,255,0.1)]"
                    >
                      <span className="relative z-10 flex items-center justify-center gap-3">
                        {joining ? <><div className="w-5 h-5 border-2 border-[#0b111a]/20 border-t-[#0b111a] rounded-full animate-spin" /> Connecting…</> : 'Join Cyberspace'}
                      </span>
                    </button>
                    {!isMobile && <p className="text-[11px] text-white/20 font-medium">By joining, you agree to the USPF Code of Conduct.</p>}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* ── Layout picker — hidden while whiteboard is open or someone is pinned ── */}
                {!tileCompact && !pinnedUid && (
                  <div className="absolute top-3 right-3 z-20 flex items-center gap-0.5 bg-black/40 backdrop-blur-md rounded-xl p-1 border border-white/10">
                    {[
                      { key: 'grid',      Icon: LayoutGrid,    label: 'Grid'      },
                      { key: 'spotlight', Icon: Maximize2,     label: 'Spotlight' },
                      { key: 'strip',     Icon: AlignJustify,  label: 'Strip'     },
                    ].map(({ key, Icon, label }) => (
                      <button
                        key={key}
                        onClick={() => setLayout(key)}
                        title={`${label} layout`}
                        className={`p-1.5 rounded-lg transition-all ${layout === key ? 'bg-white/15 text-white' : 'text-white/35 hover:text-white/70'}`}
                      >
                        <Icon size={13} />
                      </button>
                    ))}
                  </div>
                )}


                {/* ── Pinned layout — large top tile + bottom thumbnail row ── */}
                {!tileCompact && pinnedUid && (
                  <div className="absolute inset-0 z-10 flex flex-col gap-2 p-2">

                    {/* Main pinned tile — fills available height */}
                    <div className="flex-1 min-h-0 relative">
                      {isPinnedLocal ? (
                        <VideoTile
                          stream={screenSharing ? screenStream : localStream}
                          name={screenSharing ? 'Your Screen' : myName}
                          isLocal cameraOn={screenSharing || cameraOn}
                          localMicOn={micOn}
                          isSpotlight isPinned
                          onPin={() => setPinnedUid(null)}
                          mirror={mirrorLocal && !screenSharing}
                          onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                        />
                      ) : pinnedPeer ? (
                        <VideoTile
                          stream={remoteStreams[pinnedUid]}
                          name={pinnedPeer.name}
                          isLocal={false}
                          onRemove={isHost ? () => removeParticipant(pinnedUid, pinnedPeer.name) : undefined}
                          isSpotlight isPinned
                          onPin={() => setPinnedUid(null)}
                          remoteMicOn={pinnedPeer.micOn}
                          remoteCameraOn={pinnedPeer.cameraOn}
                          isReconnecting={false}
                        />
                      ) : null}
                    </div>

                    {/* Thumbnail row — horizontal strip centered at the bottom */}
                    {(!isPinnedLocal || participants.length > 0) && (
                      <div className="flex-shrink-0 flex items-center justify-center gap-2 overflow-x-auto" style={{ height: '148px' }}>
                        {!isPinnedLocal && (
                          <div className="flex-shrink-0 h-full rounded-2xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
                            <VideoTile
                              stream={screenSharing ? screenStream : localStream}
                              name={screenSharing ? 'Your Screen' : myName}
                              isLocal cameraOn={screenSharing || cameraOn}
                              localMicOn={micOn}
                              compact
                              onPin={() => setPinnedUid(myUid)}
                              mirror={mirrorLocal && !screenSharing}
                              onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                            />
                          </div>
                        )}
                        {participants.filter(p => p.uid !== pinnedUid).map(p => (
                          <div key={p.uid} className="flex-shrink-0 h-full rounded-2xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
                            <VideoTile
                              stream={remoteStreams[p.uid]}
                              name={p.name}
                              isLocal={false}
                              onRemove={isHost ? () => removeParticipant(p.uid, p.name) : undefined}
                              compact
                              onPin={() => setPinnedUid(p.uid)}
                              remoteMicOn={p.micOn}
                              remoteCameraOn={p.cameraOn}
                              isReconnecting={false}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Compact grid (whiteboard open) ── */}
                {tileCompact && (
                  <div className="w-full h-full p-2 flex items-center justify-center gap-3">
                    <VideoTile
                      stream={screenSharing ? screenStream : localStream}
                      name={screenSharing ? 'Your Screen' : myName}
                      isLocal cameraOn={screenSharing || cameraOn}
                      localMicOn={micOn}
                      compact
                      isPinned={pinnedUid === myUid}
                      onPin={() => setPinnedUid(v => v === myUid ? null : myUid)}
                      mirror={mirrorLocal && !screenSharing}
                      onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                    />
                    {participants.map(p => (
                      <VideoTile
                        key={p.uid}
                        stream={remoteStreams[p.uid]}
                        name={p.name}
                        isLocal={false}
                        onRemove={isHost ? () => removeParticipant(p.uid, p.name) : undefined}
                        compact
                        isPinned={pinnedUid === p.uid}
                        onPin={() => setPinnedUid(v => v === p.uid ? null : p.uid)}
                        remoteMicOn={p.micOn}
                        remoteCameraOn={p.cameraOn}
                        isReconnecting={false}
                      />
                    ))}
                  </div>
                )}

                {/* ── Grid layout ── */}
                {!tileCompact && !pinnedUid && layout === 'grid' && (
                  participants.length === 0 ? (
                    // Solo — fill the entire stage with no padding or aspect-ratio constraint
                    <VideoTile
                      stream={screenSharing ? screenStream : localStream}
                      name={screenSharing ? 'Your Screen' : myName}
                      isLocal cameraOn={screenSharing || cameraOn}
                      localMicOn={micOn}
                      isPinned={pinnedUid === myUid}
                      onPin={() => setPinnedUid(v => v === myUid ? null : myUid)}
                      mirror={mirrorLocal && !screenSharing}
                      onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                      isSpotlight coverFill
                    />
                  ) : (
                    <div className={`w-full h-full p-4 sm:p-6 grid gap-4 sm:gap-5 content-center ${tileCols}`}>
                      <VideoTile
                        stream={screenSharing ? screenStream : localStream}
                        name={screenSharing ? 'Your Screen' : myName}
                        isLocal cameraOn={screenSharing || cameraOn}
                        localMicOn={micOn}
                        isPinned={pinnedUid === myUid}
                        onPin={() => setPinnedUid(v => v === myUid ? null : myUid)}
                        mirror={mirrorLocal && !screenSharing}
                        onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                      />
                      {participants.map(p => (
                        <VideoTile
                          key={p.uid}
                          stream={remoteStreams[p.uid]}
                          name={p.name}
                          isLocal={false}
                          onRemove={isHost ? () => removeParticipant(p.uid, p.name) : undefined}
                          isPinned={pinnedUid === p.uid}
                          onPin={() => setPinnedUid(v => v === p.uid ? null : p.uid)}
                          remoteMicOn={p.micOn}
                          remoteCameraOn={p.cameraOn}
                          isReconnecting={false}
                        />
                      ))}
                    </div>
                  )
                )}

                {/* ── Spotlight layout ── */}
                {!tileCompact && !pinnedUid && layout === 'spotlight' && (
                  <div className="w-full h-full flex flex-col gap-4 p-4 sm:p-5">
                    <div className="flex-1 min-h-0">
                      {spotlightPeer ? (
                        <VideoTile
                          stream={spotlightStream}
                          name={spotlightName}
                          isLocal={false}
                          onRemove={isHost ? () => removeParticipant(spotlightPeer.uid, spotlightName) : undefined}
                          isSpotlight
                          onPin={() => setPinnedUid(spotlightPeer.uid)}
                          remoteMicOn={spotlightPeer.micOn}
                          remoteCameraOn={spotlightPeer.cameraOn}
                          isReconnecting={false}
                        />
                      ) : (
                        <VideoTile
                          stream={screenSharing ? screenStream : localStream}
                          name={screenSharing ? 'Your Screen' : myName}
                          isLocal cameraOn={screenSharing || cameraOn}
                          localMicOn={micOn}
                          isSpotlight
                          onPin={() => setPinnedUid(myUid)}
                          mirror={mirrorLocal && !screenSharing}
                          onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                        />
                      )}
                    </div>
                    {(participants.length > 1 || spotlightPeer) && (
                      <div className="h-32 sm:h-36 flex-shrink-0 flex gap-3 overflow-x-auto pb-1">
                        {spotlightPeer && (
                          <VideoTile
                            stream={screenSharing ? screenStream : localStream}
                            name={screenSharing ? 'Your Screen' : myName}
                            isLocal cameraOn={screenSharing || cameraOn}
                            localMicOn={micOn}
                            compact
                            onPin={() => setPinnedUid(myUid)}
                            mirror={mirrorLocal && !screenSharing}
                            onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                          />
                        )}
                        {stripPeers.map(p => (
                          <VideoTile
                            key={p.uid}
                            stream={remoteStreams[p.uid]}
                            name={p.name}
                            isLocal={false}
                            compact
                            onClick={() => setSpotlightUid(p.uid)}
                            onPin={() => setPinnedUid(p.uid)}
                            remoteMicOn={p.micOn}
                            remoteCameraOn={p.cameraOn}
                            isReconnecting={false}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Strip layout ── */}
                {!tileCompact && !pinnedUid && layout === 'strip' && (
                  <div className="w-full h-full flex items-center justify-center gap-4 p-4 sm:p-5 overflow-x-auto">
                    <VideoTile
                      stream={screenSharing ? screenStream : localStream}
                      name={screenSharing ? 'Your Screen' : myName}
                      isLocal cameraOn={screenSharing || cameraOn}
                      localMicOn={micOn}
                      compact
                      onPin={() => setPinnedUid(myUid)}
                      mirror={mirrorLocal && !screenSharing}
                      onMirror={!screenSharing ? () => setMirrorLocal(v => !v) : undefined}
                    />
                    {participants.map(p => (
                      <VideoTile
                        key={p.uid}
                        stream={remoteStreams[p.uid]}
                        name={p.name}
                        isLocal={false}
                        onRemove={isHost ? () => removeParticipant(p.uid, p.name) : undefined}
                        compact
                        onPin={() => setPinnedUid(p.uid)}
                        remoteMicOn={p.micOn}
                        remoteCameraOn={p.cameraOn}
                        isReconnecting={false}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Side Overlays ── */}

          {/* Chat Sidebar Overlay */}
          {showChat && (
            <div className="absolute right-4 top-4 bottom-4 w-80 bg-[#0d1520]/95 backdrop-blur-xl border border-white/[0.08] rounded-3xl shadow-2xl flex flex-col animate-in slide-in-from-right duration-300 z-40">
              <div className="flex-shrink-0 p-4 border-b border-white/[0.06] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare size={16} className="text-[#2563eb]" />
                  <span className="text-xs font-bold text-white/80 uppercase tracking-wider">Session Chat</span>
                </div>
                <button onClick={() => setShowChat(false)} className="p-1 hover:bg-white/5 rounded-lg text-white/40"><X size={16} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
                    <MessageSquare size={32} className="mb-2" />
                    <p className="text-[10px] font-medium">No messages yet</p>
                  </div>
                ) : (
                  chatMessages.map((msg, i) => {
                    const isMe = msg.uid === myUidRef.current
                    return (
                      <div key={msg.id || i} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                        {!isMe && <span className="text-[10px] font-bold text-white/40 mb-1 ml-1">{msg.name}</span>}
                        <div className={`px-4 py-2.5 rounded-2xl text-xs max-w-[85%] shadow-sm ${isMe ? 'bg-[#2563eb] text-white rounded-tr-none' : 'bg-white/5 text-white/90 rounded-tl-none border border-white/5'}`}>
                          {msg.text}
                        </div>
                        <span className="text-[9px] text-white/20 mt-1 mx-1">{fmtChatTime(msg.ts)}</span>
                      </div>
                    )
                  })
                )}
                <div ref={chatBottomRef} />
              </div>
              <form onSubmit={sendChat} className="p-4 border-t border-white/[0.06]">
                <div className="relative">
                  <input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder="Send a message..."
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-4 pr-12 text-xs text-white placeholder-white/20 focus:outline-none focus:border-[#2563eb]/50 transition"
                  />
                  <button type="submit" className="absolute right-2 top-2 p-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-xl shadow-lg transition active:scale-95">
                    <Send size={14} />
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Participants Overlay */}
          {showParticipants && (
            <div className="absolute right-4 top-4 bottom-4 w-72 bg-[#0d1520]/97 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl flex flex-col animate-in slide-in-from-right duration-300 z-40">
              <div className="flex-shrink-0 px-4 py-3 border-b border-white/[0.07] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users size={14} className="text-[#2563eb]" />
                  <span className="text-xs font-bold text-white/80">People ({participants.length + 1})</span>
                </div>
                <button onClick={() => setShowParticipants(false)} className="p-1.5 hover:bg-white/8 rounded-lg text-white/40 hover:text-white/70 transition"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">

                {/* ── Local user row ── */}
                <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.05] transition group">
                  {/* Avatar with status badges */}
                  <div className="relative flex-shrink-0">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#1e3a8a] to-[#2563eb] flex items-center justify-center text-sm font-black text-white shadow-md">
                      {myName[0]?.toUpperCase()}
                    </div>
                    {/* Mic badge */}
                    <div className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full flex items-center justify-center shadow-lg border-2 border-[#0d1520] ${!micOn ? 'bg-red-500' : 'bg-[#1e293b]'}`}>
                      {!micOn ? <MicOff size={9} className="text-white" /> : <Mic size={9} className="text-green-400" />}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-white truncate">{myName}</p>
                    <p className="text-[10px] text-white/35 font-medium">You {isHost ? '· Host' : '· Guest'}</p>
                  </div>
                  {/* Camera status */}
                  <div className={`flex-shrink-0 p-1.5 rounded-lg ${!cameraOn ? 'bg-red-500/15' : 'bg-white/[0.04]'}`}>
                    {!cameraOn ? <CameraOff size={12} className="text-red-400" /> : <Camera size={12} className="text-white/30" />}
                  </div>
                  {/* Pin self */}
                  <button
                    onClick={() => { setPinnedUid(v => v === myUid ? null : myUid); setShowParticipants(false) }}
                    title={pinnedUid === myUid ? 'Unpin' : 'Pin your tile'}
                    className={`flex-shrink-0 p-1.5 rounded-lg transition ${pinnedUid === myUid ? 'bg-[#2563eb]/20 text-[#2563eb]' : 'text-white/20 hover:text-white/60 hover:bg-white/[0.05]'}`}
                  >
                    {pinnedUid === myUid ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                </div>

                {/* ── Remote participant rows ── */}
                {participants.map(p => (
                  <div key={p.uid} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.05] transition group">
                    {/* Avatar with mic badge */}
                    <div className="relative flex-shrink-0">
                      <div className="w-10 h-10 rounded-full bg-white/8 flex items-center justify-center text-sm font-black text-white/80 border border-white/[0.06]">
                        {p.name[0]?.toUpperCase()}
                      </div>
                      <div className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full flex items-center justify-center shadow-lg border-2 border-[#0d1520] ${p.micOn === false ? 'bg-red-500' : 'bg-[#1e293b]'}`}>
                        {p.micOn === false ? <MicOff size={9} className="text-white" /> : <Mic size={9} className="text-green-400" />}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-white truncate">{p.name}</p>
                      <p className="text-[10px] text-white/30">
                        {p.micOn === false && p.cameraOn === false ? 'Muted · Cam off'
                          : p.micOn === false ? 'Muted'
                          : p.cameraOn === false ? 'Camera off'
                          : 'Active'}
                      </p>
                    </div>
                    {/* Camera status */}
                    <div className={`flex-shrink-0 p-1.5 rounded-lg ${p.cameraOn === false ? 'bg-red-500/15' : 'bg-white/[0.04]'}`}>
                      {p.cameraOn === false ? <CameraOff size={12} className="text-red-400" /> : <Camera size={12} className="text-white/30" />}
                    </div>
                    {/* Pin button */}
                    <button
                      onClick={() => { setPinnedUid(v => v === p.uid ? null : p.uid); setShowParticipants(false) }}
                      title={pinnedUid === p.uid ? 'Unpin' : 'Pin to focus'}
                      className={`flex-shrink-0 p-1.5 rounded-lg transition ${pinnedUid === p.uid ? 'bg-[#2563eb]/20 text-[#2563eb]' : 'text-white/20 hover:text-white/60 hover:bg-white/[0.05]'}`}
                    >
                      {pinnedUid === p.uid ? <PinOff size={12} /> : <Pin size={12} />}
                    </button>
                    {/* Remove (host only) */}
                    {isHost && (
                      <button
                        onClick={() => removeParticipant(p.uid, p.name)}
                        className="flex-shrink-0 p-1.5 text-white/15 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition"
                        title="Remove"
                      >
                        <UserX size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Invite Button Section */}
              {((isHost || sessionStorage.getItem('dev_user')) && joined) && (
                <div className="p-4 border-t border-white/[0.06]">
                  <button
                    onClick={() => setShowInvite(!showInvite)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/[0.08] transition text-xs font-bold text-white/60"
                  >
                    <UserPlus size={14} /> Invite Someone
                  </button>

                  {showInvite && (
                    <div className="mt-4 p-4 rounded-2xl bg-white/5 border border-white/10 animate-in zoom-in-95 duration-200">
                      <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-3 text-center">Enter Student ID</p>
                      <form onSubmit={handleInvite} className="space-y-2">
                        <input
                          value={inviteInput}
                          onChange={e => setInviteInput(e.target.value)}
                          placeholder="21-00123"
                          className="w-full text-center bg-black/40 border border-white/10 rounded-xl py-2.5 text-xs text-white placeholder-white/10 focus:outline-none focus:border-[#2563eb]/50 transition"
                        />
                        {inviteStatus && (
                          <p className={`text-[10px] text-center font-medium ${inviteStatus.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                            {inviteStatus.text}
                          </p>
                        )}
                        <button
                          disabled={inviteLoading || !inviteInput.trim()}
                          className="w-full py-2.5 rounded-xl bg-[#2563eb] hover:bg-[#1d4ed8] text-white text-xs font-bold shadow-lg shadow-blue-500/20 transition active:scale-[0.98]"
                        >
                          {inviteLoading ? 'Sending...' : 'Send Invitation'}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Whiteboard (inline below video grid) ── */}
        {showWhiteboard && (
          <div className="flex-1 min-h-0 bg-white border-t-2 border-gray-200 flex flex-col overflow-hidden animate-in slide-in-from-bottom duration-200">

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest mr-1">
                <PenLine className="w-3.5 h-3.5 text-[#2563eb]" /> Whiteboard
              </span>

              {canDraw ? (
                <>
                  <div className="flex gap-1">
                    {[
                      { key: 'pen',    Icon: PenLine, label: 'Pen'    },
                      { key: 'text',   Icon: Type,    label: 'Text'   },
                      { key: 'eraser', Icon: Eraser,  label: 'Eraser' },
                    ].map(({ key, Icon, label }) => (
                      <button
                        key={key}
                        onClick={() => { setTool(key); setTextPos(null); setTextInput('') }}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${tool === key
                          ? 'bg-[#2563eb] text-white shadow-sm'
                          : 'bg-white text-gray-500 hover:bg-gray-100 border border-gray-200'
                          }`}
                      >
                        <Icon className="w-3 h-3" /> {label}
                      </button>
                    ))}
                  </div>
                  {/* Font size — only shown when text tool active */}
                  {tool === 'text' && (
                    <div className="flex items-center gap-1 ml-1">
                      <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide">Size</span>
                      <select
                        value={fontSize}
                        onChange={e => setFontSize(Number(e.target.value))}
                        className="text-xs border border-gray-200 rounded-lg px-1.5 py-1 bg-white text-gray-700 focus:outline-none"
                      >
                        {[12, 16, 20, 28, 36, 48].map(s => (
                          <option key={s} value={s}>{s}px</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="flex gap-1 items-center ml-1">
                    {COLORS.map(c => (
                      <button
                        key={c}
                        onClick={() => { setColor(c); setTool('pen') }}
                        style={{ background: c }}
                        className={`w-5 h-5 rounded-full border transition-transform ${color === c && tool === 'pen'
                          ? 'border-gray-500 scale-125 shadow'
                          : 'border-gray-300 hover:scale-110'
                          }`}
                      />
                    ))}
                    <input
                      type="color"
                      value={color}
                      onChange={e => { setColor(e.target.value); setTool('pen') }}
                      className="w-5 h-5 rounded-full cursor-pointer border border-gray-300"
                      title="Custom color"
                    />
                  </div>
                </>
              ) : myGrantStatus === 'requested' ? (
                <div className="flex items-center gap-2 text-amber-600">
                  <Clock className="w-3.5 h-3.5 animate-pulse" />
                  <span className="text-xs font-semibold">Waiting for the host to allow you…</span>
                </div>
              ) : (
                <button
                  onClick={requestDrawAccess}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#1e3a8a] text-white hover:bg-[#1a174d] transition"
                >
                  <PenLine className="w-3 h-3" /> Request to draw
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                {/* Host: pending draw requests to approve */}
                {isHost && pendingDraws.map(req => (
                  <div key={req.uid} className="flex items-center gap-1 bg-amber-50 border border-amber-200 rounded-lg pl-2 pr-1 py-1">
                    <span className="text-[10px] font-semibold text-amber-700 max-w-[110px] truncate">{req.name} wants to draw</span>
                    <button onClick={() => grantDrawAccess(req.uid)} title="Allow" className="p-1 rounded text-emerald-600 hover:bg-emerald-100">
                      <Check className="w-3.5 h-3.5" strokeWidth={3} />
                    </button>
                    <button onClick={() => denyDrawAccess(req.uid)} title="Deny" className="p-1 rounded text-red-500 hover:bg-red-100">
                      <X className="w-3.5 h-3.5" strokeWidth={3} />
                    </button>
                  </div>
                ))}
                {isHost && (
                  <button
                    onClick={clearWhiteboard}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-600 hover:bg-red-50 border border-gray-200 hover:border-red-200 transition"
                  >
                    <Trash2 className="w-3 h-3" /> Clear
                  </button>
                )}
                <button
                  onClick={() => setShowWhiteboard(false)}
                  title="Close whiteboard"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Canvas area — position:relative so text box overlays correctly */}
            <div className="flex-1 relative min-h-0">
              {/* "Click to place" hint */}
              {canDraw && tool === 'text' && !textPos && (
                <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none z-10">
                  <div className="bg-[#2563eb] text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5">
                    <Type size={11} /> Click on the canvas to place a text box
                  </div>
                </div>
              )}

              <canvas
                ref={canvasRef}
                className={`w-full h-full touch-none bg-white ${
                  !canDraw ? 'cursor-default' : tool === 'text' ? 'cursor-text' : 'cursor-crosshair'
                }`}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={stopDraw}
                onMouseLeave={stopDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={stopDraw}
              />

              {/* Inline text box — appears exactly where user clicked */}
              {textPos && (
                <div
                  className="absolute z-20"
                  style={{ left: textPos.px, top: textPos.py }}
                >
                  <textarea
                    ref={textInputRef}
                    value={textInput}
                    rows={2}
                    onChange={e => setTextInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmText() }
                      if (e.key === 'Escape') { setTextPos(null); setTextInput('') }
                    }}
                    placeholder="Type here…"
                    style={{
                      font: `${fontSize}px/1.4 sans-serif`,
                      color,
                      minWidth: '120px',
                      maxWidth: '500px',
                      resize: 'both',
                    }}
                    className="block border-2 border-dashed border-[#2563eb] rounded-lg px-3 py-2 bg-white/90 backdrop-blur-sm outline-none shadow-xl"
                  />
                  <div className="flex items-center gap-1.5 mt-1">
                    <button
                      onMouseDown={e => { e.preventDefault(); confirmText() }}
                      disabled={!textInput.trim()}
                      className="px-2.5 py-1 bg-[#2563eb] disabled:opacity-40 text-white text-[10px] font-bold rounded-md"
                    >Place</button>
                    <button
                      onMouseDown={e => { e.preventDefault(); setTextPos(null); setTextInput('') }}
                      className="px-2.5 py-1 border border-gray-300 text-gray-500 text-[10px] font-semibold rounded-md bg-white"
                    >Cancel</button>
                    <span className="text-[9px] text-gray-400">Enter to place · Shift+Enter newline · Esc cancel</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* ── Bottom Control Bar ── */}
      <div className={`${isMobile ? 'h-14' : 'h-16'} flex-shrink-0 bg-[#0d1520]/80 backdrop-blur-xl border-t border-white/[0.07] flex items-center justify-center gap-2`}>
        <CtrlBtn onClick={toggleMic} active={micOn} disabled={!joined} title={micOn ? 'Mute' : 'Unmute'}>
          {micOn ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
        </CtrlBtn>

        <CtrlBtn onClick={toggleCamera} active={cameraOn} disabled={!joined} title={cameraOn ? 'Turn camera off' : 'Turn camera on'}>
          {cameraOn ? <Camera className="w-4 h-4" /> : <CameraOff className="w-4 h-4" />}
        </CtrlBtn>

        <div className="w-px h-6 bg-white/10" />

        <CtrlBtn onClick={() => setShowParticipants(!showParticipants)} active={showParticipants} title="Participants & Invite">
          <Users className="w-4 h-4" />
        </CtrlBtn>

        <CtrlBtn onClick={() => setShowChat(!showChat)} active={showChat} badge={unreadChat} title="Chat">
          <MessageSquare className="w-4 h-4" />
        </CtrlBtn>

        <CtrlBtn onClick={joined ? () => setShowWhiteboard(v => !v) : undefined} disabled={!joined} dot={whiteboardAlert} title={showWhiteboard ? 'Close whiteboard' : 'Open whiteboard'}>
          <PenLine className="w-4 h-4" />
        </CtrlBtn>

        <CtrlBtn onClick={joined ? toggleScreenShare : undefined} active={screenSharing} disabled={!joined} title={screenSharing ? 'Stop sharing' : 'Share screen'}>
          {screenSharing ? <ScreenShareOff className="w-4 h-4" /> : <ScreenShare className="w-4 h-4" />}
        </CtrlBtn>

        <div className="w-px h-6 bg-white/10" />

        <CtrlBtn onClick={joined ? leaveSession : undefined} disabled={!joined} danger title="Leave session">
          <PhoneOff className="w-4 h-4" />
        </CtrlBtn>
      </div>

      {/* ── Custom Dialog ── */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#0d1520] border border-white/[0.08] rounded-3xl shadow-2xl w-full max-w-xs p-6 animate-in zoom-in-95 duration-200">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4 ${dialog.type === 'danger' ? 'bg-red-500/10' : 'bg-[#2563eb]/15'}`}>
              {dialog.type === 'danger'
                ? <UserX className="w-6 h-6 text-red-400" />
                : <AlertCircle className="w-6 h-6 text-[#2563eb]" />
              }
            </div>
            <p className="text-white text-sm font-bold text-center mb-1.5">{dialog.title}</p>
            <p className="text-white/50 text-xs text-center leading-relaxed mb-6">{dialog.message}</p>
            <div className="flex gap-2">
              {dialog.onCancel && (
                <button
                  onClick={dialog.onCancel}
                  className="flex-1 py-2.5 rounded-2xl bg-white/5 border border-white/10 text-white/60 text-xs font-bold hover:bg-white/10 transition active:scale-95"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={dialog.onConfirm}
                className={`flex-1 py-2.5 rounded-2xl text-white text-xs font-bold transition active:scale-95 shadow-lg ${dialog.type === 'danger'
                  ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20'
                  : 'bg-[#2563eb] hover:bg-[#1d4ed8] shadow-blue-500/20'
                  }`}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
