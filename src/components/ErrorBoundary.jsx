import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

/**
 * LCspace — Global Error Boundary
 * Catches any unhandled React render/lifecycle errors and shows a
 * clean fallback instead of a blank or broken page.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, errorId: null, errorMsg: '', errorStack: '' }
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorId: Math.random().toString(36).slice(2, 8).toUpperCase(),
      errorMsg: error?.message || String(error),
      errorStack: (error?.stack || '').split('\n').slice(0, 4).join('\n'),
    }
  }

  componentDidCatch(error, info) {
    // In production you'd send this to a monitoring service (e.g. Sentry)
    console.error('[LCspace ErrorBoundary]', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">

          <div className="w-14 h-14 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-5">
            <AlertTriangle className="w-7 h-7 text-red-500" />
          </div>

          <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-gray-500 text-sm leading-relaxed mb-1">
            An unexpected error occurred. Your data is safe — please refresh the page to continue.
          </p>
          <p className="text-gray-400 text-xs mb-6">
            Error reference: <span className="font-mono font-bold">{this.state.errorId}</span>
          </p>

          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#262367] text-white rounded-xl text-sm font-semibold hover:bg-[#35318c] transition"
          >
            <RefreshCw className="w-4 h-4" />
            Reload page
          </button>

          <p className="mt-6 text-xs text-gray-400">
            If this keeps happening, contact{' '}
            <a href="mailto:support@uspf.edu.ph" className="text-[#262367] hover:underline">
              support@uspf.edu.ph
            </a>
          </p>
        </div>
      </div>
    )
  }
}
