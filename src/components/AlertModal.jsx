import { AlertTriangle, Info, CheckCircle2, AlertOctagon, X } from 'lucide-react'

/**
 * Polished, reusable alert / confirm modal.
 *
 * config shape:
 * {
 *   type: 'alert' | 'confirm',
 *   variant?: 'info' | 'success' | 'warning' | 'danger',
 *   title: string,
 *   message: string | ReactNode,
 *   confirmLabel?: string,   // default: 'Confirm' (or 'OK' for alerts)
 *   cancelLabel?: string,    // default: 'Cancel'
 *   destructive?: boolean,   // styles the primary button red
 *   onConfirm?: () => void,
 * }
 */

const VARIANT_STYLES = {
  info:    { ring: 'ring-[#262367]/10',  iconBg: 'bg-[#262367]/10',  iconColor: 'text-[#262367]', Icon: Info },
  success: { ring: 'ring-emerald-200',   iconBg: 'bg-emerald-100',   iconColor: 'text-emerald-600', Icon: CheckCircle2 },
  warning: { ring: 'ring-amber-200',     iconBg: 'bg-amber-100',     iconColor: 'text-amber-600',  Icon: AlertTriangle },
  danger:  { ring: 'ring-red-200',       iconBg: 'bg-red-100',       iconColor: 'text-red-600',    Icon: AlertOctagon },
}

export default function AlertModal({ config, onClose }) {
  if (!config) return null

  const variant = config.variant || (config.destructive ? 'danger' : (config.type === 'confirm' ? 'warning' : 'info'))
  const { iconBg, iconColor, Icon } = VARIANT_STYLES[variant] || VARIANT_STYLES.info

  const close = () => onClose?.()
  const confirm = () => {
    if (config.onConfirm) config.onConfirm()
    close()
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={close}
    >
      <div className="relative bg-white rounded-2xl w-full max-w-sm shadow-2xl animate-in zoom-in-95 duration-150 overflow-hidden" onClick={e => e.stopPropagation()}>
        <button
          onClick={close}
          className="absolute top-3.5 right-3.5 text-gray-400 hover:text-gray-700 p-1.5 rounded-md hover:bg-gray-100 transition z-10"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="px-7 pt-8 pb-6">
          <div className={`w-12 h-12 rounded-full ${iconBg} flex items-center justify-center mb-4`}>
            <Icon className={`w-6 h-6 ${iconColor}`} />
          </div>
          <h3 className="text-base font-semibold text-gray-900 leading-snug">
            {config.title}
          </h3>
          <p className="mt-1.5 text-sm text-gray-500 leading-relaxed whitespace-pre-wrap">
            {config.message}
          </p>
        </div>

        <div className="px-7 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2">
          {config.type === 'confirm' && (
            <button
              onClick={close}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 hover:bg-white border border-gray-200 transition"
            >
              {config.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            onClick={confirm}
            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-sm transition ${
              config.destructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-[#262367] hover:bg-[#1a1745]'
            }`}
          >
            {config.confirmLabel || (config.type === 'confirm' ? 'Confirm' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  )
}
