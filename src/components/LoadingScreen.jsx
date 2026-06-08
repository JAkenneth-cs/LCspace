// Skeleton pulse block helper
function Sk({ className = '' }) {
  return <div className={`animate-pulse rounded-lg bg-white/10 ${className}`} />
}
function SkL({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-gray-200 ${className}`} />
}

function SidebarSkeleton({ isAdmin }) {
  return (
    <aside className="w-64 bg-[#262367] text-white flex flex-col fixed inset-y-0 left-0 z-30 border-r border-white/10">
      {/* Brand */}
      <div className="h-[60px] px-5 flex items-center gap-3 border-b border-white/10">
        <div className="w-8 h-8 rounded-full bg-white/10 animate-pulse" />
        <div className="space-y-1.5">
          <Sk className="h-3 w-20" />
          <Sk className="h-2 w-28" />
        </div>
      </div>

      {/* Nav items */}
      <div className="flex-1 px-3 py-5 space-y-1">
        {[...Array(isAdmin ? 7 : 6)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-xl">
            <Sk className="w-4 h-4 rounded" />
            <Sk className="h-3 rounded" style={{ width: `${52 + (i * 11) % 36}%` }} />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-4 border-t border-white/10">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Sk className="w-4 h-4 rounded" />
          <Sk className="h-3 w-14" />
        </div>
      </div>
    </aside>
  )
}

function TopBarSkeleton() {
  return (
    <header className="h-[60px] bg-white border-b border-gray-100 px-6 flex items-center justify-between sticky top-0 z-20">
      <div className="space-y-1.5">
        <SkL className="h-4 w-28" />
        <SkL className="h-2.5 w-36" />
      </div>
      {/* Center welcome */}
      <div className="hidden sm:flex flex-col items-center gap-1">
        <SkL className="h-2 w-16" />
        <SkL className="h-3.5 w-24" />
      </div>
      <div className="flex items-center gap-3">
        <SkL className="w-9 h-9 rounded-full" />
        <div className="hidden sm:flex flex-col gap-1 pl-3 border-l border-gray-100">
          <SkL className="h-3 w-24" />
          <SkL className="h-2 w-16" />
        </div>
      </div>
    </header>
  )
}

/* ── Overview skeleton ───────────────────────────────────────────── */
function OverviewSkeleton() {
  return (
    <div className="p-6 space-y-6">
      {/* Hero banner */}
      <div className="rounded-3xl overflow-hidden" style={{ height: 260 }}>
        <SkL className="w-full h-full rounded-3xl" />
      </div>

      {/* 2-col grid: announcements + booking */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Announcements card */}
        <div className="bg-[#262367] rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Sk className="w-4 h-4 rounded" />
            <Sk className="h-3.5 w-28" />
          </div>
          {[...Array(3)].map((_, i) => (
            <div key={i} className="space-y-2 pb-3 border-b border-white/10 last:border-0 last:pb-0">
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-4/5" />
              <Sk className="h-2.5 w-20" />
            </div>
          ))}
        </div>

        {/* Booking card */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-2">
            <SkL className="w-4 h-4 rounded" />
            <SkL className="h-3.5 w-32" />
          </div>
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50">
              <SkL className="w-10 h-10 rounded-xl" />
              <div className="flex-1 space-y-1.5">
                <SkL className="h-3 w-32" />
                <SkL className="h-2.5 w-24" />
              </div>
              <SkL className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* Facilities section header */}
      <div className="space-y-1">
        <SkL className="h-4 w-36" />
        <SkL className="h-2.5 w-52" />
      </div>

      {/* Facilities grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3 shadow-sm">
            <SkL className="w-9 h-9 rounded-xl" />
            <div className="space-y-1.5">
              <SkL className="h-3 w-20" />
              <SkL className="h-2.5 w-12" />
            </div>
            <SkL className="h-8 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Book Facility skeleton ──────────────────────────────────────── */
function BookingSkeleton() {
  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div className="space-y-1">
        <SkL className="h-5 w-40" />
        <SkL className="h-3 w-64" />
      </div>
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <SkL className="w-7 h-7 rounded-full" />
            {i < 4 && <SkL className="h-0.5 w-8 rounded" />}
          </div>
        ))}
      </div>
      {/* Form card */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm space-y-5">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-2">
            <SkL className="h-3 w-24" />
            <SkL className="h-11 w-full rounded-xl" />
          </div>
        ))}
        <SkL className="h-11 w-full rounded-xl mt-2" />
      </div>
    </div>
  )
}

/* ── My Bookings skeleton ────────────────────────────────────────── */
function MyBookingsSkeleton() {
  return (
    <div className="p-6 space-y-5">
      <div className="space-y-1">
        <SkL className="h-5 w-32" />
        <SkL className="h-3 w-52" />
      </div>
      {/* Filter tabs */}
      <div className="flex gap-2">
        {[...Array(4)].map((_, i) => (
          <SkL key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>
      {/* Booking cards */}
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm flex items-center gap-4">
            <SkL className="w-12 h-12 rounded-2xl" />
            <div className="flex-1 space-y-2">
              <SkL className="h-4 w-40" />
              <SkL className="h-3 w-28" />
              <SkL className="h-2.5 w-20" />
            </div>
            <SkL className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Guide & Rules skeleton ──────────────────────────────────────── */
function GuideSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <SkL className="h-6 w-40" />
        <SkL className="h-3 w-72" />
      </div>
      {[...Array(3)].map((_, i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <SkL className="w-9 h-9 rounded-xl" />
            <div className="space-y-1.5">
              <SkL className="h-4 w-32" />
              <SkL className="h-2.5 w-48" />
            </div>
          </div>
          <div className="space-y-2 pt-2">
            {[...Array(3)].map((_, j) => (
              <SkL key={j} className="h-2.5 w-full" />
            ))}
            <SkL className="h-2.5 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Generic content skeleton ────────────────────────────────────── */
function GenericSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <SkL className="h-5 w-36" />
        <SkL className="h-3 w-52" />
      </div>
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <SkL className="w-9 h-9 rounded-xl" />
            <div className="flex-1 space-y-2">
              <SkL className="h-4 w-40" />
              <SkL className="h-2.5 w-28" />
            </div>
          </div>
          <SkL className="h-2.5 w-full" />
          <SkL className="h-2.5 w-4/5" />
        </div>
      ))}
    </div>
  )
}

export default function LoadingScreen({ type = 'student', page = 'overview' }) {
  const isAdmin = type === 'admin'

  const pageContent = {
    overview: <OverviewSkeleton />,
    book: <BookingSkeleton />,
    bookings: <MyBookingsSkeleton />,
    guide: <GuideSkeleton />,
  }

  const content = pageContent[page] ?? <GenericSkeleton />

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <SidebarSkeleton isAdmin={isAdmin} />

      <div className="ml-64 flex-1 flex flex-col min-h-screen overflow-y-auto">
        <TopBarSkeleton />
        <main className="flex-1">
          {content}
        </main>
      </div>
    </div>
  )
}
