import { useState } from 'react'
import { Bell, X, CheckCircle2, AlertTriangle, Info, CalendarClock, Check } from 'lucide-react'
import { useTheme } from '../lib/ThemeContext'

const TYPE_CONFIG = {
  reminder: { Icon: CalendarClock, color: 'text-[#262367]', bg: 'bg-[#262367]/10' },
  success:  { Icon: CheckCircle2,  color: 'text-emerald-500', bg: 'bg-emerald-500/15' },
  warning:  { Icon: AlertTriangle, color: 'text-amber-400',   bg: 'bg-amber-500/15' },
  info:     { Icon: Info,          color: 'text-blue-400',    bg: 'bg-blue-500/15' },
  alert:    { Icon: Info,          color: 'text-blue-400',    bg: 'bg-blue-500/15' },
}

export default function NotificationBell({ notifications = [], onDismiss }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [open, setOpen] = useState(false)
  const [readIds, setReadIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('lcspace_read_notifs') || '[]') } catch { return [] }
  })

  const unreadCount = notifications.filter(n => !readIds.includes(n.id)).length

  function markRead(id) {
    setReadIds(prev => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      localStorage.setItem('lcspace_read_notifs', JSON.stringify(next))
      return next
    })
  }

  function markAllRead() {
    const next = notifications.map(n => n.id)
    setReadIds(next)
    localStorage.setItem('lcspace_read_notifs', JSON.stringify(next))
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`relative w-10 h-10 rounded-xl flex items-center justify-center transition shadow-sm ${
          isDark
            ? 'bg-white/10 border border-white/10 hover:bg-white/15'
            : 'bg-white border border-gray-200 hover:bg-gray-50'
        }`}
        title="Notifications"
      >
        <Bell className={`w-4 h-4 ${isDark ? 'text-white/70' : 'text-gray-500'}`} />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-[#F5C900] rounded-full flex items-center justify-center text-[10px] font-bold text-[#262367] px-1 shadow">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 top-12 w-80 rounded-2xl shadow-2xl z-50 overflow-hidden ${
            isDark
              ? 'bg-[#1a1740] border border-white/10'
              : 'bg-white border border-gray-100'
          }`}>

            {/* Header */}
            <div className={`flex items-center justify-between px-4 py-3.5 border-b ${
              isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-100'
            }`}>
              <div className="flex items-center gap-2">
                <Bell className={`w-4 h-4 ${isDark ? 'text-[#F5C900]' : 'text-[#262367]'}`} />
                <p className={`font-bold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>Notifications</p>
                {unreadCount > 0 && (
                  <span className="bg-[#262367] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{unreadCount}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button onClick={markAllRead}
                    className={`text-[11px] font-semibold transition ${isDark ? 'text-[#F5C900] hover:text-yellow-300' : 'text-[#262367] hover:text-[#35318c]'}`}>
                    Mark all read
                  </button>
                )}
                <button onClick={() => setOpen(false)}
                  className={`w-6 h-6 rounded-lg flex items-center justify-center transition ${
                    isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
                  }`}>
                  <X className={`w-3 h-3 ${isDark ? 'text-white/70' : 'text-gray-600'}`} />
                </button>
              </div>
            </div>

            {/* List */}
            {notifications.length === 0 ? (
              <div className="p-10 text-center">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                  <Bell className={`w-5 h-5 ${isDark ? 'text-white/20' : 'text-gray-300'}`} />
                </div>
                <p className={`font-semibold text-sm ${isDark ? 'text-white/40' : 'text-gray-400'}`}>All caught up!</p>
                <p className={`text-xs mt-1 ${isDark ? 'text-white/25' : 'text-gray-300'}`}>No notifications right now</p>
              </div>
            ) : (
              <div className={`max-h-80 overflow-y-auto divide-y ${isDark ? 'divide-white/5' : 'divide-gray-50'}`}>
                {notifications.map(n => {
                  const cfg = TYPE_CONFIG[n.type] || TYPE_CONFIG.info
                  const { Icon } = cfg
                  const isRead = readIds.includes(n.id)
                  return (
                    <div key={n.id}
                      className={`flex gap-3 px-4 py-3.5 transition ${
                        isRead
                          ? 'opacity-40'
                          : isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50/80'
                      }`}>
                      <div className={`w-8 h-8 rounded-xl ${cfg.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                        <Icon className={`w-4 h-4 ${cfg.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className={`text-sm font-semibold ${isRead ? (isDark ? 'text-white/30' : 'text-gray-400') : (isDark ? 'text-white' : 'text-gray-900')}`}>{n.title}</p>
                          {!isRead && <span className="w-1.5 h-1.5 rounded-full bg-[#F5C900] flex-shrink-0" />}
                        </div>
                        <p className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-white/50' : 'text-gray-500'}`}>{n.message}</p>
                        {n.time && (
                          <p className={`text-[10px] mt-1 font-medium uppercase tracking-wide ${isDark ? 'text-white/30' : 'text-gray-400'}`}>{n.time}</p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 flex-shrink-0">
                        {!isRead && (
                          <button onClick={(e) => { e.stopPropagation(); markRead(n.id) }}
                            className={`w-6 h-6 flex items-center justify-center rounded-lg transition ${isDark ? 'text-white/20 hover:bg-emerald-500/20 hover:text-emerald-400' : 'text-gray-300 hover:bg-emerald-50 hover:text-emerald-500'}`}
                            title="Mark as read">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {onDismiss && (
                          <button onClick={(e) => { e.stopPropagation(); onDismiss(n.id) }}
                            className={`w-6 h-6 flex items-center justify-center rounded-lg transition ${isDark ? 'text-white/20 hover:bg-red-500/20 hover:text-red-400' : 'text-gray-300 hover:bg-red-50 hover:text-red-500'}`}
                            title="Dismiss">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Footer */}
            <div className={`px-4 py-3 border-t ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-100'}`}>
              <p className={`text-[10px] text-center font-medium ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                {unreadCount > 0 ? `${unreadCount} unread` : 'All read'} · {notifications.length} total
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
