import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChevronLeft,
  Droplets,
  Loader2,
  MapPin,
  Satellite,
  Search,
  Sparkles,
  Trees,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import MapPicker from './MapPicker'

type Point = { lat: number; lon: number }

type DateRow = {
  year: string
  date: string
  cloud: number
  scene: string
  sensor: string
  resolution: number
  green: number
  water: number
  bare: number
  spot?: { water: number; green: number; built: number; bare: number; seen: number }
  seen: number
  image: string
}

type Hotspot = {
  kind: 'building' | 'lost greenery' | 'new water'
  stage?: 'built' | 'open'
  built_share?: number
  area_m2: number
  lat: number
  lon: number
  crop: string | null
}

type Around = {
  radius_m: number
  transit_radius_m: number
  groups: { key: string; label: string; count: number; nearest_m: number | null }[]
}

type Pair = {
  from: string
  to: string
  hotspots?: Hotspot[]
  seen: number
  changed: number
  lostGreen: number
  newBuilt: number
  newWater: number
  overlay: string
}

type Analysis = {
  site: { id: string; name: string; centre: number[]; bbox: number[]; note: string }
  generated: string
  source: string
  grid: number[]
  dates: DateRow[]
  pairs: Pair[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function spotLabel(s: { water: number; green: number; built: number; bare: number; seen: number }) {
  if (s.seen < 40) return 'hidden by cloud'
  const ranked: [string, number][] = [
    ['building', s.built],
    ['planting', s.green],
    ['water', s.water],
    ['open ground', s.bare],
  ]
  ranked.sort((a, b) => b[1] - a[1])
  if (ranked[0][1] < 30) return 'mixed ground'
  return ranked[0][0]
}

function spotTone(label: string) {
  if (label === 'building') return 'bg-clay-soft text-clay'
  if (label === 'planting') return 'bg-forest-soft text-forest'
  if (label === 'water') return 'bg-[#e6f0f6] text-sky'
  return 'bg-sunk text-ink-2'
}

function areaLabel(m2: number) {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(1)} km²`
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(1)} ha`
  return `${Math.round(m2)} m²`
}

function shortDate(iso: string) {
  const [y, m] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

function longDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

function points(a: number, b: number) {
  const diff = Math.round((b - a) * 10) / 10
  if (Math.abs(diff) < 0.2) return 'about the same'
  return `${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)} points`
}

function signed(n: number) {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`
}

function slugFor(p: Point) {
  return `p_${p.lat.toFixed(4)}_${p.lon.toFixed(4)}`.replace(/-/g, 'm').replace(/\./g, '_')
}

const EXAMPLES: { name: string; lat: number; lon: number }[] = [
  { name: 'Business Bay', lat: 25.186, lon: 55.27 },
  { name: 'Dubai Marina', lat: 25.0805, lon: 55.14 },
  { name: 'Palm Jumeirah', lat: 25.1124, lon: 55.139 },
  { name: 'Expo City', lat: 24.9605, lon: 55.1495 },
]

export default function App() {
  const [point, setPoint] = useState<Point | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ name: string; lat: number; lon: number }[]>([])
  const [phase, setPhase] = useState<'pick' | 'running' | 'ready' | 'error'>('pick')
  const [data, setData] = useState<Analysis | null>(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [pending, setPending] = useState('')
  const [years, setYears] = useState<number[]>([2002, 2019, 2025])
  const [recent, setRecent] = useState<{ name: string; lat: number; lon: number }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('backstory:recent') || '[]') as { name: string; lat: number; lon: number }[]
    } catch {
      return []
    }
  })
  const timer = useRef<number | null>(null)
  const booted = useRef(false)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (booted.current) return
    booted.current = true
    const lat = Number(q.get('lat'))
    const lon = Number(q.get('lon'))
    if (q.get('lat') && Number.isFinite(lat) && Number.isFinite(lon)) {
      const name = q.get('name') || 'This place'
      const chosen = (q.get('y') || '')
        .split(',')
        .map(Number)
        .filter((y) => Number.isInteger(y) && y >= 1999 && y <= 2026)
      const list = chosen.length >= 2 ? chosen : [2002, 2019, 2025]
      setPoint({ lat, lon })
      setQuery(name)
      setYears(list)
      void analyze({ lat, lon }, name, list)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'running') return
    const started = Date.now()
    timer.current = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 400)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [phase])

  async function search(q: string) {
    setQuery(q)
    if (q.trim().length < 3) return setHits([])
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
        { headers: { accept: 'application/json' } },
      )
      const json = (await res.json()) as { display_name: string; lat: string; lon: string }[]
      setHits(json.map((r) => ({ name: r.display_name.split(',').slice(0, 3).join(','), lat: Number(r.lat), lon: Number(r.lon) })))
    } catch {
      setHits([])
    }
  }

  async function analyze(p: Point, name: string, list: number[] = years) {
    const ordered = [...new Set(list)].sort((x, y) => x - y)
    const isDefault = ordered.join(',') === '2002,2019,2025'
    const slug = slugFor(p) + (isDefault ? '' : `_y${ordered.join('-')}`)
    const query = new URLSearchParams({
      lat: p.lat.toFixed(5),
      lon: p.lon.toFixed(5),
      name,
      y: ordered.join(','),
    })
    window.history.replaceState({}, '', `?${query.toString()}`)
    setYears(ordered)
    setPending(name)
    setPhase('running')
    setError('')
    setElapsed(0)
    try {
      const res = await fetch(
        `/api/analyze?lat=${p.lat}&lon=${p.lon}&slug=${slug}&name=${encodeURIComponent(name)}&years=${ordered.join(',')}`,
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
        throw new Error(body.detail || body.error || `HTTP ${res.status}`)
      }
      setData((await res.json()) as Analysis)
      setPhase('ready')
      setRecent((prev) => {
        const next = [{ name, lat: p.lat, lon: p.lon }, ...prev.filter((r) => r.name !== name)].slice(0, 3)
        try {
          localStorage.setItem('backstory:recent', JSON.stringify(next))
        } catch {
          /* private mode */
        }
        return next
      })
      window.scrollTo({ top: 0 })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'analysis failed')
      setPhase('error')
    }
  }

  return (
    <div className="min-h-screen">
      <Header onHome={() => { setPhase('pick'); setData(null); window.history.replaceState({}, '', '/') }} />

      {phase === 'pick' && (
        <Landing
          point={point}
          query={query}
          hits={hits}
          onSearch={search}
          onPick={(p) => setPoint(p)}
          onChoose={(h) => {
            setPoint({ lat: h.lat, lon: h.lon })
            setQuery(h.name)
            setHits([])
          }}
          onRun={(p, n) => analyze(p, n)}
          recent={recent}
        />
      )}

      {phase === 'running' && (
        <main className="mx-auto flex min-h-[62vh] max-w-md flex-col items-start px-6 pt-20 sm:pt-28">
          <h2 className="text-[26px] sm:text-[30px]">Reading {pending || 'this place'}</h2>
          <p className="mt-2 text-[13.5px] text-ink-2">Real imagery, fetched now. Usually under a minute.</p>
          <ol className="mt-7 w-full space-y-0">
            {[
              ['Finding the clearest pass', 0, 'searching the archives for three frames'],
              ['Masking cloud and shadow', 8, 'so nothing is counted that was hidden'],
              ['Measuring change', 22, 'pixel by pixel, between every pair'],
              ['Grouping the change into places', 40, 'so you can see where it happened'],
            ].map(([title, at, note]) => {
              const seconds = Number(at)
              const done = elapsed > seconds + 6
              const active = elapsed >= seconds && !done
              return (
                <li key={String(title)} className="flex gap-3 border-t border-line py-3 first:border-0">
                  <span
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] ${
                      done
                        ? 'border-forest bg-forest text-white'
                        : active
                          ? 'border-forest text-forest'
                          : 'border-line-2 text-ink-3'
                    }`}
                  >
                    {done ? '✓' : active ? <Loader2 className="h-3 w-3 animate-spin" /> : ''}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[13.5px] ${done ? 'text-ink-3' : 'text-ink'}`}>{title}</span>
                    <span className="block text-[11.5px] text-ink-3">{note}</span>
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="mt-5 tnum text-[11.5px] text-ink-3">{elapsed}s elapsed</p>
        </main>
      )}

      {phase === 'error' && (
        <main className="mx-auto max-w-xl px-6 pt-20">
          <div className="panel p-7">
            <TriangleAlert className="h-5 w-5 text-clay" strokeWidth={1.7} />
            <h2 className="mt-3 text-[24px]">That place didn’t come back clean</h2>
            <p className="mt-2 text-[13.5px] whitespace-pre-wrap text-ink-2">{error}</p>
            <button onClick={() => setPhase('pick')} className="mt-5 rounded-lg border border-line-2 px-4 py-2 text-[13px] hover:border-ink-3">
              Try another place
            </button>
          </div>
        </main>
      )}

      {phase === 'ready' && data && (
        <Report
          data={data}
          years={years}
          onAddYear={(y) => analyze({ lat: data.site.centre[0], lon: data.site.centre[1] }, data.site.name, [...years, y])}
          onBack={() => {
            setPhase('pick')
            setData(null)
            window.history.replaceState({}, '', '/')
          }}
        />
      )}
    </div>
  )
}

function Header({ onHome }: { onHome: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <button onClick={onHome} className="group flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-forest text-[11px] font-semibold text-white">B</span>
          <span className="font-serif text-[19px] tracking-tight">Backstory</span>
        </button>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] text-ink-2 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-forest-2" />
            Sentinel-2 · Landsat · open data
          </span>
          <a
            href="#how"
            className="hidden text-[12.5px] text-ink-2 hover:text-ink sm:block"
          >
            How it works
          </a>
        </div>
      </div>
    </header>
  )
}

function Landing({
  point,
  query,
  hits,
  onSearch,
  onPick,
  onChoose,
  onRun,
  recent,
}: {
  point: Point | null
  query: string
  hits: { name: string; lat: number; lon: number }[]
  onSearch: (q: string) => void
  onPick: (p: Point) => void
  onChoose: (h: { name: string; lat: number; lon: number }) => void
  onRun: (p: Point, name: string) => void
  recent: { name: string; lat: number; lon: number }[]
}) {
  return (
    <main className="pb-24">
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-[11.5px] text-ink-2">
            <Sparkles className="h-3 w-3 text-forest" strokeWidth={2} />
            Satellite history for any address
          </span>
          <h1 className="mt-5 text-[38px] leading-[1.06] sm:text-[58px]">
            Look at the ground,
            <br />
            not the listing.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-2 sm:text-[16.5px]">
            Two decades of real satellite imagery for any address in Dubai — what changed, how much of it became
            building, and what the pictures cannot tell you.
          </p>

        <div className="relative mt-7 max-w-2xl lg:max-w-none">
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-card px-2 py-2 shadow-[0_10px_30px_-18px_rgba(18,19,15,0.4)] focus-within:border-forest/40">
            <Search className="ml-2 h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.9} />
            <input
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search a building, street or area"
              className="min-w-0 flex-1 bg-transparent py-2 text-[14.5px] outline-none placeholder:text-ink-3"
            />
            <button
              onClick={() => point && onRun(point, query || 'This place')}
              disabled={!point}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-forest px-3 py-2 text-[13px] font-medium text-white transition enabled:hover:bg-forest-2 disabled:opacity-35 sm:px-4"
              aria-label="Read this place"
            >
              <span className="hidden sm:inline">Read this place</span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.2} />
            </button>
          </div>

          {hits.length > 0 && (
            <ul className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-line bg-card shadow-xl">
              {hits.map((h) => (
                <li key={`${h.lat},${h.lon}`}>
                  <button
                    onClick={() => onChoose(h)}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] hover:bg-sunk"
                  >
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-3" strokeWidth={1.9} />
                    <span className="truncate">{h.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            <span>Try</span>
            {EXAMPLES.map((e) => (
              <button
                key={e.name}
                onClick={() => {
                  onPick({ lat: e.lat, lon: e.lon })
                  onRun({ lat: e.lat, lon: e.lon }, e.name)
                }}
                className="rounded-full border border-line bg-card px-2.5 py-1 text-[12px] text-ink-2 transition hover:border-forest/40 hover:text-forest"
              >
                {e.name}
              </button>
            ))}
          </div>

          {recent.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
              <span>Recently read</span>
              {recent.map((r) => (
                <button
                  key={r.name}
                  onClick={() => onRun({ lat: r.lat, lon: r.lon }, r.name)}
                  className="rounded-full bg-sunk px-2.5 py-1 text-[12px] text-ink-2 transition hover:text-forest"
                >
                  {r.name.split(',')[0]}
                </button>
              ))}
            </div>
          )}
        </div>
        </div>

        <figure className="hidden overflow-hidden rounded-[20px] border border-line bg-card lg:block">
          <div className="relative aspect-[4/3] overflow-hidden">
            <img src="/sites/rgb_p_25_1860_55_2700_2025.png" alt="Business Bay in 2025" className="absolute inset-0 h-full w-full scale-[1.18] object-cover" />
            <img
              src="/sites/rgb_p_25_1860_55_2700_2019.png"
              alt="Business Bay in 2019"
              className="absolute inset-0 h-full w-full scale-[1.18] object-cover"
              style={{ clipPath: 'inset(0 52% 0 0)' }}
            />
            <div className="pointer-events-none absolute inset-y-0 left-[48%] w-px bg-white/90" />
            <span className="absolute top-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[10.5px] font-medium text-white backdrop-blur">2019</span>
            <span className="absolute top-3 right-3 rounded-full bg-black/55 px-2.5 py-1 text-[10.5px] font-medium text-white backdrop-blur">2025</span>
          </div>
          <figcaption className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span className="text-[12.5px] text-ink-2">Business Bay, Dubai</span>
            <span className="tnum text-[12px] font-medium text-forest">8.2% changed</span>
          </figcaption>
        </figure>
      </section>

      <section className="mx-auto mt-10 max-w-6xl px-5 sm:px-8">
        <div className="relative overflow-hidden rounded-[20px] border border-line bg-sunk">
          <MapPicker point={point} onPick={onPick} className="h-[280px] w-full sm:h-[380px]" />
          <div className="pointer-events-none absolute top-3 left-3 rounded-full bg-white/88 px-3 py-1.5 text-[11.5px] text-ink-2 backdrop-blur">
            Click anywhere to drop a pin
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-line bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5 text-[13px]">
            <MapPin className="h-4 w-4 text-forest" strokeWidth={1.9} />
            {point ? (
              <span className="text-ink">
                {query || 'Pinned'} <span className="tnum text-ink-3">· {point.lat.toFixed(4)}, {point.lon.toFixed(4)}</span>
              </span>
            ) : (
              <span className="text-ink-3">No place chosen yet</span>
            )}
          </div>
          <button
            onClick={() => point && onRun(point, query || 'This place')}
            disabled={!point}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-forest px-4 py-2.5 text-[13.5px] font-medium text-white transition enabled:hover:bg-forest-2 disabled:opacity-35"
          >
            Read this place
            <ArrowRight className="h-4 w-4" strokeWidth={2.1} />
          </button>
        </div>
      </section>

      <section id="how" className="mx-auto mt-16 max-w-6xl px-5 sm:px-8">
        <p className="label">What you get</p>
        <div className="mt-4 grid gap-x-10 gap-y-7 sm:grid-cols-3">
          {[
            { t: 'Two dated pictures', d: 'The same ground in 2002, 2019 and 2025, swiped against each other. Not a rendering — the satellite frames.' },
            { t: 'Numbers with receipts', d: 'How much changed, how much became building, what the greenery did. Every claim opens to its method and its cloud cover.' },
            { t: 'What it cannot see', d: 'Noise, air at street level, service charges. Written down plainly, next to the closest thing the imagery does support.' },
          ].map((f) => (
            <div key={f.t} className="border-t border-line pt-4">
              <p className="text-[14.5px] font-medium">{f.t}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <Footer />
    </main>
  )
}

function YearAdd({ current, onAdd }: { current: number[]; onAdd: (y: number) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line-2 px-2.5 py-1 text-[11.5px] text-ink-2 transition hover:border-ink-3 hover:text-ink"
      >
        + year
      </button>
    )
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const y = Number(value)
        setOpen(false)
        setValue('')
        if (y >= 1999 && y <= 2026 && !current.includes(y)) onAdd(y)
      }}
      className="flex items-center gap-1"
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder="2016"
        inputMode="numeric"
        aria-label="Another year to read"
        className="tnum w-16 rounded-lg border border-line-2 bg-card px-2 py-1 text-[11.5px] outline-none focus:border-forest"
      />
      <button className="rounded-lg bg-forest px-2 py-1 text-[11.5px] text-white">Read</button>
    </form>
  )
}

function Report({
  data,
  years,
  onAddYear,
  onBack,
}: {
  data: Analysis
  years: number[]
  onAddYear: (y: number) => void
  onBack: () => void
}) {
  const dates = data.dates
  const [aYear, setAYear] = useState(dates[Math.max(0, dates.length - 2)].year)
  const [bYear, setBYear] = useState(dates[dates.length - 1].year)
  const [pos, setPos] = useState(50)
  const [overlay, setOverlay] = useState(false)
  const [ask, setAsk] = useState('')
  const [around, setAround] = useState<Around | null>(null)
  const [copied, setCopied] = useState(false)
  const [log, setLog] = useState<{ q: string; a: string; loading?: boolean }[]>([])

  const a = dates.find((d) => d.year === aYear) ?? dates[0]
  const b = dates.find((d) => d.year === bYear) ?? dates[dates.length - 1]
  const pair = data.pairs.find((p) => p.from === a.year && p.to === b.year)
  const mixed = a.sensor !== b.sensor
  const greenDelta = Math.round((b.green - a.green) * 10) / 10
  const missing = years.filter((y) => !dates.some((d) => d.year === String(y)))
  const span = Math.max(1, Number(b.year) - Number(a.year))
  const perYear = pair ? Math.round((pair.changed / span) * 10) / 10 : null
  const openSites = pair?.hotspots?.filter((h) => h.stage === 'open').length ?? 0

  useEffect(() => {
    let live = true
    const [lat, lon] = data.site.centre
    setAround(null)
    fetch(`/api/around?lat=${lat}&lon=${lon}&slug=${data.site.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Around) => {
        if (live) setAround(d)
      })
      .catch(() => {
        /* the card simply does not appear */
      })
    return () => {
      live = false
    }
  }, [data.site.centre])

  function localAnswer(q: string): string {
    const t = q.toLowerCase()
    if (/nois|sound|loud|traffic|airport/.test(t))
      return 'A satellite cannot hear. The closest thing this imagery supports is how much building has appeared around the point — not what it sounds like at 7am.'
    if (/air|pollut|smoke|dust/.test(t))
      return 'Satellite air-quality data comes in cells kilometres wide. It describes a city, never a building, so it cannot tell you what the air is like here.'
    if (/electric|utility|service charge|internet|maintenance|manager/.test(t))
      return 'Not visible from orbit. Those are records held by the developer, the utility and the owners association.'
    if (/price|cost|worth|invest|yield|rent/.test(t))
      return 'Backstory does not price anything. The imagery shows what changed and how fast; a price needs the market, the building and the paperwork.'
    if (/before|history|was here|used to|previous|old|empty/.test(t))
      return `The earliest frame is ${longDate(a.date)} (${a.sensor}, ${a.resolution} m). ${pair ? `Between then and ${b.year}, ${pair.changed}% of the land here changed.` : ''}`
    if (/green|tree|park|garden|shade|plant/.test(t))
      return `Planted ground is ${b.green}% now, against ${a.green}% on ${longDate(a.date)} — ${points(a.green, b.green)}.`
    if (/build|construct|tower|develop|demolit|crane/.test(t))
      return pair
        ? `About ${pair.newBuilt}% of the land here went from bare ground to building between ${a.year} and ${b.year}.`
        : 'Pick two dates to see how much was built.'
    if (/water|flood|rain|drain|canal/.test(t))
      return `Open water is ${b.water}% of the area now, against ${a.water}% in ${a.year}. That is water visible in these frames — not a flood-risk model.`
    return `I can answer questions about greenery, building, water and change between two dates. For “${q.trim()}” this imagery has no answer, and I would rather say so than invent one.`
  }

  async function answer(q: string) {
    const question = q.trim()
    if (!question) return
    setAsk('')
    setLog((l) => [{ q: question, a: 'Reading the imagery…', loading: true }, ...l].slice(0, 3))
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, facts: factsOf(data, a, b, pair, around), images: [a.image, b.image] }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { text?: string }
      if (!body.text) throw new Error('empty')
      setLog((l) => [{ q: question, a: body.text as string }, ...l.slice(1)].slice(0, 3))
    } catch {
      setLog((l) => [{ q: question, a: localAnswer(question) }, ...l.slice(1)].slice(0, 3))
    }
  }

  return (
    <main className="pb-24">
      <div className="sticky top-16 z-20 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-5 sm:px-8">
          <button onClick={onBack} className="flex items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink">
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            Another place
          </button>
          <div className="flex items-center gap-3">
            <span className="tnum hidden text-[12px] text-ink-3 sm:block">
              {data.site.note} · {b.resolution} m per pixel
            </span>
            <YearAdd current={years} onAdd={onAddYear} />
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(window.location.href)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              }}
              className="rounded-lg border border-line-2 px-2.5 py-1 text-[11.5px] text-ink-2 transition hover:border-ink-3 hover:text-ink"
            >
              {copied ? 'Link copied' : 'Share'}
            </button>
          </div>
        </div>
      </div>

      <section className="mx-auto max-w-6xl px-5 pt-8 sm:px-8 sm:pt-10">
        <p className="label">
          {shortDate(a.date)} → {shortDate(b.date)}
        </p>
        <h1 className="mt-2 max-w-3xl text-[30px] leading-[1.1] sm:text-[42px]">{data.site.name}</h1>
        <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-ink-2 sm:text-[15.5px]">{summary(a, b, pair, mixed, dates)}</p>
        {missing.length > 0 && (
          <p className="mt-2 max-w-2xl text-[12.5px] text-ink-3">
            {missing.join(', ')} had no pass clear enough to use at this spot, so {missing.length > 1 ? 'they were' : 'it was'} left out
            rather than filled with a bad frame.
          </p>
        )}
      </section>

      <section className="mx-auto mt-7 grid max-w-6xl grid-cols-2 gap-3 px-5 sm:gap-4 sm:px-8 lg:grid-cols-4">
        <Stat value={pair ? `${pair.changed}%` : '—'} label="of the land changed" />
        <Stat value={pair && !mixed ? `${pair.newBuilt}%` : '—'} label="became building" />
        <Stat value={`${signed(greenDelta)}`} label="greenery, points" tone={greenDelta < 0 ? 'down' : 'up'} />
        <Stat value={`${signed(Math.round((b.bare - a.bare) * 10) / 10)}`} label="open ground, points" />
      </section>

      {dates[0].spot && (
        <section className="mx-auto mt-5 max-w-6xl px-5 sm:px-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-card px-4 py-2.5">
            <span className="label">At the pin</span>
            {dates.map((d, i) => {
              const label = d.spot ? spotLabel(d.spot) : 'unknown'
              const coarse = d.resolution >= 30
              return (
                <span
                  key={d.year}
                  className="flex items-center gap-1.5 text-[12.5px]"
                  title={coarse ? `${d.resolution} m pixels — this window is smaller than one pixel` : undefined}
                >
                  {i > 0 && <span className="hidden text-ink-3 sm:inline">→</span>}
                  <span className="tnum text-ink-3">{d.year}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11.5px] ${
                      coarse ? 'border border-dashed border-line-2 text-ink-3' : spotTone(label)
                    }`}
                  >
                    {label}
                  </span>
                </span>
              )
            })}
            <span className="ml-auto hidden text-[11px] text-ink-3 sm:block">seven pixels around the centre, per frame</span>
          </div>
        </section>
      )}

      <section className="mx-auto mt-6 grid max-w-6xl gap-6 px-5 sm:px-8 lg:grid-cols-[1.45fr_1fr]">
        <div className="panel rise overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5 sm:px-4">
            <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:items-center">
              <DatePill label="Before" value={a.year} dates={dates} onChange={setAYear} />
              <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 text-ink-3 sm:block" strokeWidth={2} />
              <DatePill label="After" value={b.year} dates={dates} onChange={setBYear} />
            </div>
            <button
              onClick={() => setOverlay((v) => !v)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-[11.5px] transition ${
                overlay ? 'border-forest bg-forest text-white' : 'border-line-2 text-ink-2 hover:border-ink-3'
              }`}
            >
              {overlay ? 'Hide change layer' : 'Show change layer'}
            </button>
          </div>

          <div
            className="relative w-full select-none overflow-hidden bg-sunk"
            style={{ aspectRatio: `${data.grid[0]} / ${data.grid[1]}` }}
          >
            <img src={b.image} alt={b.year} className="absolute inset-0 h-full w-full object-cover" />
            <img
              src={a.image}
              alt={a.year}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
            />
            {overlay && pair && <img src={pair.overlay} alt="detected change" className="absolute inset-0 h-full w-full object-cover opacity-75" />}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.18)]"
              style={{ left: `${pos}%` }}
            >
              <div className="absolute top-1/2 -left-4 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-white text-[11px] text-ink shadow-md">
                ⇄
              </div>
            </div>
            <span className="absolute top-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[10.5px] font-medium text-white backdrop-blur">
              {a.year} · {a.sensor}
            </span>
            <span className="absolute top-3 right-3 rounded-full bg-black/55 px-2.5 py-1 text-[10.5px] font-medium text-white backdrop-blur">
              {b.year} · {b.sensor}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
              aria-label="Compare the two dates"
              className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
            />
          </div>

          <div className="flex gap-1.5 border-t border-line p-2">
            {dates.map((d) => (
              <button
                key={d.year}
                onClick={() => setAYear(d.year)}
                className={`flex-1 overflow-hidden rounded-lg border transition ${
                  a.year === d.year ? 'border-forest' : 'border-transparent hover:border-line-2'
                }`}
              >
                <img src={d.image} alt="" className="h-11 w-full object-cover sm:h-14" />
                <span className="block bg-card py-0.5 text-center text-[10px] text-ink-2">{d.year}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-[10.5px] text-ink-3 sm:px-4">
            <span>{data.source}</span>
            <span className="tnum">
              {a.cloud}% / {b.cloud}% cloud · {a.seen}% / {b.seen}% visible
            </span>
          </div>
        </div>

        <div className="space-y-0">
          {mixed && (
            <div className="mb-3 flex gap-2.5 rounded-xl border border-clay/25 bg-clay-soft px-3.5 py-2.5 text-[12px] text-ink-2">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-clay" strokeWidth={2} />
              <span>
                {a.year} is {a.sensor} at {a.resolution} m, {b.year} is {b.sensor} at {b.resolution} m. Different pixel
                sizes — use this pair for the picture, not for a number.
              </span>
            </div>
          )}

          <div className="overflow-hidden rounded-[20px] border border-line bg-card">
            <Finding
              icon={<Trees className="h-4 w-4" strokeWidth={1.8} />}
              title="Greenery"
              sentence={`Planted ground went from ${a.green}% to ${b.green}% of this area — ${points(a.green, b.green)}.`}
              detail="Trees, lawns and irrigated landscaping, as a share of the pixels the satellite could actually see — not of the district."
            />
            {pair && !mixed && (
              <Finding
                icon={<Building2 className="h-4 w-4" strokeWidth={1.8} />}
                title="Bare ground that became building"
                sentence={`About ${pair.newBuilt}% of the land went from open ground to building between the two dates.`}
                detail="Change is claimed, never absolute area. Desert and concrete reflect short-wave infrared too similarly to separate reliably here, so no “per cent built” figure is published — only movement between two dates."
              />
            )}
            {pair && (
              <Finding
                icon={<Satellite className="h-4 w-4" strokeWidth={1.8} />}
                title="How much actually moved"
                sentence={`${pair.changed}% of the land here looks materially different between the two dates.`}
                detail={`Measured only where both images had a clear view (${pair.seen}% of the frame), and excluding open water, whose edge moves with tide and level.`}
              />
            )}
            <Finding
              icon={<Droplets className="h-4 w-4" strokeWidth={1.8} />}
              title="Water"
              sentence={`Open water went from ${a.water}% to ${b.water}% — ${points(a.water, b.water)}.`}
              detail="Read from how water absorbs near-infrared. At 10 m per pixel a wet road and a decorative pool both read as water, so small movements are noise."
              last
            />
          </div>

          <div className="mt-3 rounded-[20px] border border-line bg-card p-4">
            <p className="label">What the satellites saw</p>
            <ul className="mt-2">
              {dates.map((d) => (
                <li key={d.year} className="flex items-baseline justify-between gap-2 border-t border-line py-1.5 first:border-0 first:pt-0">
                  <span className="tnum text-[12px] text-ink">{shortDate(d.date)}</span>
                  <span className="text-right text-[11.5px] text-ink-3">
                    {d.sensor} · {d.resolution} m · {d.cloud}% cloud · {d.seen}% clear
                    <span className="block truncate font-mono text-[10px] text-ink-3/70" title={d.scene}>
                      {d.scene}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
              Sentinel-2 frames are pulled from the same October–December window. Older Landsat years use the clearest
              pass of that year, which lands within about a month of the others here.
            </p>
          </div>
        </div>
      </section>

      {pair?.hotspots && pair.hotspots.length > 0 && (
        <section className="mx-auto mt-10 max-w-6xl px-5 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="label">Where it changed</p>
              <h2 className="mt-1.5 text-[21px] sm:text-[25px]">
                The {pair.hotspots.length} biggest moves, measured
              </h2>
            </div>
            <p className="text-[11px] text-ink-3">
              each crop: {a.year} on the left, {b.year} on the right
            </p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {pair.hotspots.map((h, i) => (
              <div key={i} className="group flex items-center gap-3 rounded-2xl border border-line bg-card p-2.5 transition hover:border-line-2">
                {h.crop ? (
                  <img src={h.crop} alt={`${h.kind} near ${h.lat.toFixed(4)}, ${h.lon.toFixed(4)}`} className="h-16 w-28 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-16 w-28 shrink-0 rounded-lg bg-sunk" />
                )}
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-forest" />
                    {h.kind === 'building' ? 'New building' : h.kind === 'lost greenery' ? 'Vegetation lost' : 'New water'}
                  </p>
                  <p className="tnum mt-0.5 text-[12px] text-ink-2">{areaLabel(h.area_m2)} of change</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {h.stage && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                          h.stage === 'built' ? 'bg-forest-soft text-forest' : 'bg-clay-soft text-clay'
                        }`}
                      >
                        {h.stage === 'built' ? `built by ${b.year}` : 'still open ground'}
                      </span>
                    )}
                    <span className="tnum text-[10.5px] text-ink-3">
                      {h.lat.toFixed(4)}, {h.lon.toFixed(4)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mx-auto mt-10 grid max-w-6xl gap-6 px-5 sm:px-8 lg:grid-cols-3">
        <div className="rounded-[20px] border border-line bg-card p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 text-clay" strokeWidth={2} />
            <h2 className="text-[17px]">Where this stops</h2>
          </div>
          <p className="mt-1.5 text-[13px] text-ink-3">Everything below is outside what these two frames can show.</p>
          <ul className="mt-4 space-y-3.5">
            {[
              ['Noise', 'A satellite cannot hear. Closest measurable: how much building has appeared around the point.'],
              ['Air at street level', 'Satellite pollution data comes in cells kilometres wide. It describes a city, never a building.'],
              ['Electricity, service charges', 'Held by the developer, the utility and the owners association. Not visible from orbit.'],
              [`Finer than 10 m, or under cloud`, `${a.seen}% of this area was readable in ${a.year}, ${b.seen}% in ${b.year}. The rest is gap, not zero.`],
            ].map(([t, d]) => (
              <li key={t} className="border-l-2 border-clay/30 pl-3">
                <p className="text-[13px] font-medium">{t}</p>
                <p className="text-[12.5px] leading-relaxed text-ink-2">{d}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-[20px] border border-line bg-card p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-sky" strokeWidth={2} />
            <h2 className="text-[17px]">The neighbourhood</h2>
          </div>
          <p className="mt-1.5 text-[13px] text-ink-3">
            Map data, not imagery{around ? ` — within ${around.radius_m} m` : ''}.
          </p>

          {perYear !== null && (
            <div className="mt-3 rounded-xl border border-line bg-canvas px-3 py-2">
              <p className="label">Momentum</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">
                {perYear}% of the land changed per year between {a.year} and {b.year}
                {openSites > 0
                  ? `, and ${openSites} of the biggest changed sites are still bare ground — building is ongoing.`
                  : ', and the biggest changed sites are already built — the area looks settled.'}
              </p>
            </div>
          )}
          {around ? (
            around.groups.length > 0 ? (
              <ul className="mt-4">
                {around.groups.map((g) => (
                  <li
                    key={g.key}
                    className="flex items-baseline justify-between gap-2 border-t border-line py-1.5 first:border-0 first:pt-0"
                  >
                    <span className="text-[12.5px]">{g.label}</span>
                    <span className="tnum shrink-0 text-[11.5px] text-ink-2">
                      {g.count}

                      {g.nearest_m !== null && ` · ${g.nearest_m} m`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-[12.5px] text-ink-2">Nothing mapped within {around.radius_m} m.</p>
            )
          ) : (
            <div className="mt-4 space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-4 animate-pulse rounded bg-sunk" />
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
            OpenStreetMap is volunteer-mapped. In a new district an empty row means nobody has mapped it yet, not that
            it is not there.
          </p>
        </div>

        <div className="flex flex-col rounded-[20px] border border-line bg-card p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-forest" strokeWidth={2} />
            <h2 className="text-[17px]">Ask it something</h2>
          </div>
          <p className="mt-1.5 text-[13px] text-ink-3">
            It looks at both frames and reads the numbers above. It stops where the imagery stops.
          </p>

          <button
            onClick={() =>
              answer(
                'In two sentences: say what you can actually see changed in these two images, then name where the biggest measured change is. Use the figures for any number.',
              )
            }
            className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-forest/25 bg-forest-soft px-3.5 py-2.5 text-left transition hover:border-forest/50"
          >
            <span>
              <span className="block text-[12.5px] font-medium text-forest">Explain what changed</span>
              <span className="block text-[11px] text-ink-2">Sends both frames to the model with the measurements</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-forest" strokeWidth={2} />
          </button>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {['Was this empty land?', 'Is the greenery going?', 'Is it noisy here?', 'Did water ever stand here?'].map((q) => (
              <button
                key={q}
                onClick={() => answer(q)}
                className="rounded-full border border-line-2 px-2.5 py-1 text-[11.5px] text-ink-2 transition hover:border-forest hover:text-forest"
              >
                {q}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (ask.trim()) answer(ask)
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              placeholder="Ask about this place…"
              className="min-w-0 flex-1 rounded-xl border border-line-2 bg-canvas px-3 py-2.5 text-[13px] outline-none focus:border-forest"
            />
            <button className="rounded-xl bg-forest px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-forest-2">
              Ask
            </button>
          </form>

          <div className="mt-4 space-y-2">
            {log.length === 0 && (
              <p className="text-[13px] text-ink-3">Nothing asked yet. Try the noise one — it is the answer people remember.</p>
            )}
            {log.map((entry, i) => (
              <div key={i} className="rounded-xl border border-line bg-sunk/60 p-3">
                <p className="text-[11.5px] font-medium text-ink-2">{entry.q}</p>
                <p className="mt-1 flex items-start gap-1.5 text-[13px] leading-relaxed">
                  {entry.loading && <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-ink-3" />}
                  <span className={entry.loading ? 'text-ink-3' : ''}>{entry.a}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer detail={`Frames ${dates.map((d) => d.date).join(' · ')} · analysis ${data.generated.slice(0, 10)}`} />
    </main>
  )
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-3.5 py-3 sm:px-5 sm:py-4">
      <p
        className={`tnum font-serif text-[26px] leading-none sm:text-[34px] ${
          tone === 'down' ? 'text-clay' : tone === 'up' ? 'text-forest' : 'text-ink'
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[10.5px] leading-tight text-ink-3 uppercase tracking-wide sm:text-[11px]">{label}</p>
    </div>
  )
}

function Finding({
  icon,
  title,
  sentence,
  detail,
  last,
}: {
  icon: React.ReactNode
  title: string
  sentence: string
  detail: string
  last?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`px-4 py-3.5 ${last ? '' : 'border-b border-line'}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-forest-soft text-forest">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="label">{title}</p>
          <p className="mt-1 text-[13.5px] leading-snug">{sentence}</p>
          <button onClick={() => setOpen((v) => !v)} className="mt-1.5 flex items-center gap-1 text-[11px] text-forest hover:underline">
            {open ? 'hide method' : 'how we know'}
            <ArrowUpRight className={`h-3 w-3 transition ${open ? 'rotate-90' : ''}`} strokeWidth={2} />
          </button>
          {open && <p className="mt-2 text-[12px] leading-relaxed text-ink-2">{detail}</p>}
        </div>
      </div>
    </div>
  )
}

function DatePill({
  label,
  value,
  dates,
  onChange,
}: {
  label: string
  value: string
  dates: DateRow[]
  onChange: (v: string) => void
}) {
  return (
    <label className="flex shrink-0 items-center gap-1.5">
      <span className="hidden text-[11px] text-ink-3 sm:inline">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line-2 bg-card px-2 py-1.5 text-[11px] outline-none focus:border-forest sm:w-auto sm:text-[11.5px]"
      >
        {dates.map((d) => (
          <option key={d.year} value={d.year}>
            {shortDate(d.date)} · {d.sensor}
          </option>
        ))}
      </select>
    </label>
  )
}

function Footer({ detail }: { detail?: string }) {
  return (
    <footer className="mx-auto mt-14 max-w-6xl border-t border-line px-5 pt-6 text-[11.5px] leading-relaxed text-ink-3 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>Backstory</span>
        <span>Sentinel-2 (ESA) · Landsat (USGS) · OpenFreeMap · © OpenStreetMap contributors</span>
      </div>
      <p className="mt-2 max-w-3xl">
        Cloud, shadow and missing passes are masked per pixel, so every percentage is a share of what was actually
        visible. {detail}
      </p>
    </footer>
  )
}

function factsOf(data: Analysis, a: DateRow, b: DateRow, pair: Pair | undefined, around: Around | null) {
  const span = Math.max(1, Number(b.year) - Number(a.year))
  const perYear = pair ? Math.round((pair.changed / span) * 10) / 10 : null
  const openSites = pair?.hotspots?.filter((h) => h.stage === 'open').length ?? 0
  const builtSites = pair?.hotspots?.filter((h) => h.stage === 'built').length ?? 0
  return {
    place: data.site.name,
    before: { year: a.year, date: a.date, satellite: a.sensor, resolution_m: a.resolution, planted_ground_pct: a.green, open_water_pct: a.water, bare_ground_pct: a.bare, visible_pct: a.seen, at_the_pin: a.spot ? spotLabel(a.spot) : null },
    after: { year: b.year, date: b.date, satellite: b.sensor, resolution_m: b.resolution, planted_ground_pct: b.green, open_water_pct: b.water, bare_ground_pct: b.bare, visible_pct: b.seen, at_the_pin: b.spot ? spotLabel(b.spot) : null },
    change: pair
      ? {
          same_satellite: a.sensor === b.sensor,
          changed_land_pct: pair.changed,
          became_building_pct: pair.newBuilt,
          lost_green_pct: pair.lostGreen,
          new_water_pct: pair.newWater,
          readable_both_dates_pct: pair.seen,
          hotspots: (pair.hotspots ?? []).map((h) => ({
            kind: h.kind,
            area_m2: h.area_m2,
            lat: h.lat,
            lon: h.lon,
          })),
        }
      : null,
    images_sent: 'the two frames, before and after',
    momentum: pair
      ? {
          changed_percent_per_year: perYear,
          years_compared: pair.from + '-' + pair.to,
          biggest_sites_still_bare: openSites,
          biggest_sites_already_built: builtSites,
          reading: openSites > 0 ? 'still being built out' : 'settled',
        }
      : null,
    nearby_amenities: around
      ? {
          source: 'OpenStreetMap, not the imagery',
          radius_m: around.radius_m,
          groups: around.groups.map((g) => ({ what: g.label, count: g.count, nearest_m: g.nearest_m })),
        }
      : null,
    cannot_answer: ['noise', 'street-level air quality', 'electricity and service charges', 'prices', 'anything finer than 10 m or under cloud'],
  }
}

function summary(a: DateRow, b: DateRow, pair: Pair | undefined, mixed: boolean, dates: DateRow[]) {
  if (mixed && dates.length >= 2) {
    const recent = dates.slice(-2)
    return `${a.year} is ${a.sensor} at ${a.resolution} m and ${b.year} is ${b.sensor} at ${b.resolution} m, so this pair is for looking, not measuring. For a number, compare ${recent[0].year} with ${recent[1].year} — same satellite, same pixel size.`
  }
  if (!pair) {
    return `Between ${a.year} and ${b.year}, planted ground moved from ${a.green}% to ${b.green}% of this area. Pick two dates to see what changed between them.`
  }
  return `${longDate(a.date)} to ${longDate(b.date)}: ${pair.changed}% of the land here looks materially different, about ${pair.newBuilt}% went from open ground to building, and planted ground is ${b.green}% against ${a.green}%. ${pair.seen}% was readable on both dates — the rest is excluded, not guessed.`
}
