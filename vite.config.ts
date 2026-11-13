import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const MODELS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemma-4-31b-it']

const SYSTEM = `You answer one question about one place, for someone about to buy a home there.

You are given two satellite frames of the same ground, before and after, plus a JSON of figures that
a published algorithm has already computed from those pixels. The images are the evidence; the figures
are the measurements.

These figures ARE answerable, and you must answer with the exact value given:
- planted_ground_pct — greenery, planted or irrigated ground
- open_water_pct — open water
- bare_ground_pct — open sand or bare soil
- changed_land_pct — how much of the land looks materially different
- became_building_pct — open ground that became building
- readable_both_dates_pct — how much of the area the satellites could actually see
- hotspots — ranked areas of change with their area in square metres and their coordinates

These CANNOT be answered: noise, street-level air quality, electricity or service charges, prices or
yields, anything finer than the stated resolution, anything hidden by cloud in either date, and anything
about the inside of a building.

Rules:
- Two or three sentences. Plain English. No bullets, no headings, no preamble.
- Never say "cannot answer" for a question the facts above can answer.
- Use only numbers that appear in the facts. Never invent, round or derive one.
- nearby_amenities comes from OpenStreetMap, not from the pixels. If asked about shops, schools or
  transport, answer from it and say plainly that it is map data, not imagery.
- momentum describes what the imagery shows about direction: recent change per year, and whether the
  largest changed sites are already built or still bare ground. Use it to say whether the area looks
  like it is still being built out or has settled, and say that it is read from the frames.
- If asked about crime, safety statistics, school ratings, prices or yields, say plainly that no
  neighbourhood-level dataset is published for this area and that you will not guess. Dubai Police
  publish city-wide annual rates only; you have no district figure and must not imply one.
- You may describe what you see in the images (new buildings, cleared sand, water, car parks, planting),
  but never attach a number to what you see unless that number is in the facts.
- When two frames are attached and you are asked what changed, describe at least one thing you can
  actually see (a structure, a surface, water, planting) in your own words. That is the point of
  sending you the pictures.
- If the question is answerable: state the answer with its figure, in the first sentence.
- If it is not: say plainly the imagery cannot answer it, then name the closest thing the facts do
  support — construction and building change is the honest proxy for noise, for example.
- Never mention indices, bands or sensors by technical name.
- Never print a JSON key, underscore or code identifier. Say "8.2% of the land changed", never "changed_land_pct 8.2".
- If a question mixes something you can answer with something you cannot, answer the part you can first, in full, then add the gap as one short clause. Do not refuse a whole question because one part of it is unsupported.`

function readKey(root: string): string | undefined {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  const candidates = [
    path.join(root, '.env'),
    path.join(root, '.env.local'),
    path.join(root, '..', '.env'),
    path.join(root, '..', '.env.txt'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const match = readFileSync(file, 'utf8').match(/GEMINI_API_KEY\s*=\s*["']?([^"'\s]+)/)
    if (match) return match[1]
  }
  return undefined
}

function roundCoord(v: number) {
  return Math.round(v * 1e5) / 1e5
}

function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Only files we generated, inside public/sites, and only PNGs. */
function readPublicPng(root: string, url: unknown): string | null {
  if (typeof url !== 'string') return null
  if (!/^\/sites\/[A-Za-z0-9_.-]+\.png$/.test(url)) return null
  const file = path.resolve(root, 'public', url.slice(1))
  const base = path.resolve(root, 'public', 'sites')
  if (!file.startsWith(base) || !existsSync(file)) return null
  return readFileSync(file).toString('base64')
}

async function callModel(model: string, key: string, question: string, facts: unknown, images: string[]) {
  const prompt = `Facts about this place:\n\n${JSON.stringify(facts)}\n\nQuestion: ${question}`
  const parts: Record<string, unknown>[] = []
  if (!model.startsWith('gemma')) {
    for (const data of images) parts.push({ inlineData: { mimeType: 'image/png', data } })
  }
  parts.push({ text: prompt })
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 260 },
  }
  if (!model.startsWith('gemma')) body.systemInstruction = { parts: [{ text: SYSTEM }] }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  })
  if (res.status === 404) return { retry: true as const }
  if (!res.ok) return { retry: false as const, status: res.status }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
  return text ? { text } : { retry: false as const, status: 502 }
}

function analyzeApi(): Plugin {
  return {
    name: 'backstory-api',
    configureServer(server) {
      const root = server.config.root
      const key = readKey(root)
      if (!key) server.config.logger.warn('GEMINI_API_KEY not found — /api/ask will fall back to local answers')
      const recent: number[] = []
      const cache = new Map<string, string>()

      server.middlewares.use('/api/ask', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        if (!key) return json(res, 503, { error: 'no key' })

        const now = Date.now()
        while (recent.length && now - recent[0] > 60_000) recent.shift()
        if (recent.length >= 12) return json(res, 429, { error: 'rate limited', retryAfter: 20 })
        recent.push(now)

        let payload: { question?: string; facts?: unknown; images?: unknown }
        try {
          payload = JSON.parse(
            await new Promise<string>((resolve, reject) => {
              let raw = ''
              req.on('data', (c) => (raw += c))
              req.on('end', () => resolve(raw))
              req.on('error', reject)
            }),
          ) as { question?: string; facts?: unknown; images?: unknown }
        } catch {
          return json(res, 400, { error: 'bad json' })
        }

        const question = (payload.question ?? '').slice(0, 300).trim()
        if (!question) return json(res, 400, { error: 'question required' })
        const facts = JSON.stringify(payload.facts ?? {}).slice(0, 2000)
        const urls = Array.isArray(payload.images) ? payload.images.slice(0, 2) : []
        const images = urls.map((u) => readPublicPng(root, u)).filter((v): v is string => Boolean(v))

        const cacheKey = `${facts.length}|${question.toLowerCase()}`
        const hit = cache.get(cacheKey)
        if (hit) return json(res, 200, { text: hit, cached: true, images: images.length })

        for (const model of MODELS) {
          try {
            const out = await callModel(model, key, question, payload.facts ?? {}, images)
            if ('text' in out && out.text) {
              cache.set(cacheKey, out.text)
              return json(res, 200, { text: out.text, model, images: images.length })
            }
            if ('retry' in out && !out.retry) break
          } catch (err) {
            server.config.logger.warn(`[ask] ${model}: ${String(err)}`)
          }
        }
        return json(res, 502, { error: 'no model answered' })
      })

      const aroundCache = new Map<string, unknown>()
      const GROUPS: { key: string; label: string; test: (t: Record<string, string>) => boolean }[] = [
        { key: 'food', label: 'Supermarkets and groceries', test: (t) => ['supermarket', 'convenience', 'bakery', 'greengrocer', 'butcher', 'deli'].includes(t.shop ?? '') },
        { key: 'cafe', label: 'Cafés and restaurants', test: (t) => ['cafe', 'restaurant', 'fast_food', 'food_court'].includes(t.amenity ?? '') },
        { key: 'shopping', label: 'Malls and shops', test: (t) => ['mall', 'department_store', 'clothes', 'electronics', 'shoes'].includes(t.shop ?? '') },
        { key: 'school', label: 'Schools and nurseries', test: (t) => ['school', 'kindergarten', 'college', 'university'].includes(t.amenity ?? '') },
        { key: 'health', label: 'Clinics and pharmacies', test: (t) => ['pharmacy', 'clinic', 'doctors', 'hospital', 'dentist'].includes(t.amenity ?? '') },
        { key: 'park', label: 'Parks and playgrounds', test: (t) => ['park', 'playground', 'garden'].includes(t.leisure ?? '') },
        { key: 'sport', label: 'Gyms and sports', test: (t) => ['fitness_centre', 'sports_centre', 'swimming_pool', 'pitch'].includes(t.leisure ?? '') },
        { key: 'worship', label: 'Places of worship', test: (t) => t.amenity === 'place_of_worship' },
        { key: 'bank', label: 'Banks and ATMs', test: (t) => ['bank', 'atm', 'bureau_de_change'].includes(t.amenity ?? '') },
        { key: 'parking', label: 'Public parking', test: (t) => t.amenity === 'parking' },
        { key: 'transit', label: 'Metro or train station', test: (t) => t.railway === 'station' || t.station === 'subway' },
        { key: 'bus', label: 'Bus stops', test: (t) => t.highway === 'bus_stop' || t.amenity === 'bus_station' },
      ]

      server.middlewares.use('/api/around', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://local')
        const lat = Number(url.searchParams.get('lat'))
        const lon = Number(url.searchParams.get('lon'))
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'lat and lon required' })

        const slug = (url.searchParams.get('slug') ?? '').replace(/[^a-zA-Z0-9_.-]/g, '')
        const key = `${lat.toFixed(4)},${lon.toFixed(4)}`
        const hit = aroundCache.get(key)
        if (hit) return json(res, 200, hit)

        // Warmed results live on disk, so a demo address never waits on Overpass.
        const cacheFile = slug ? path.join(root, 'public', 'sites', `around_${slug}.json`) : null
        if (cacheFile && existsSync(cacheFile)) {
          try {
            const saved = JSON.parse(readFileSync(cacheFile, 'utf8')) as unknown
            aroundCache.set(key, saved)
            return json(res, 200, saved)
          } catch {
            /* fall through and refetch */
          }
        }

        const near = (meters: number) => `node(around:${meters},${roundCoord(lat)},${roundCoord(lon)})`
        const query = `[out:json][timeout:25];(
${near(800)}["amenity"~"^(school|kindergarten|college|university|hospital|clinic|pharmacy|doctors|dentist|cafe|restaurant|fast_food|food_court|place_of_worship|bank|atm|bureau_de_change|parking|bus_station)$"];
${near(800)}["shop"~"^(supermarket|convenience|bakery|greengrocer|butcher|deli|mall|department_store|clothes|electronics|shoes)$"];
${near(800)}["leisure"~"^(park|playground|garden|fitness_centre|sports_centre|swimming_pool|pitch)$"];
${near(600)}["highway"="bus_stop"];
${near(1600)}["railway"="station"];
${near(1600)}["station"="subway"];
);out body 500;`

        try {
          let upstream: Response | null = null
          for (const wait of [0, 3000]) {
            if (wait) await new Promise((r) => setTimeout(r, wait))
            upstream = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
              headers: { accept: 'application/json', 'user-agent': 'backstory/1.0 (satellite land report demo)' },
              signal: AbortSignal.timeout(45_000),
            }).catch(() => null)
            if (upstream?.ok) break
          }
          if (!upstream?.ok) throw new Error(`overpass ${upstream?.status ?? 'unreachable'}`)
          const data = (await upstream.json()) as { elements?: { lat: number; lon: number; tags?: Record<string, string> }[] }
          const elements = (data.elements ?? []).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))

          const groups = GROUPS.map((g) => {
            const hits = elements.filter((e) => g.test(e.tags ?? {}))
            const dists = hits.map((e) => metresBetween(lat, lon, e.lat, e.lon)).sort((a, b) => a - b)
            return {
              key: g.key,
              label: g.label,
              count: hits.length,
              nearest_m: dists.length ? Math.round(dists[0]) : null,
            }
          }).filter((g) => g.count > 0)

          const payload = { radius_m: 800, transit_radius_m: 1600, groups, source: 'OpenStreetMap' }
          aroundCache.set(key, payload)
          if (cacheFile) {
            try {
              writeFileSync(cacheFile, JSON.stringify(payload, null, 2))
            } catch {
              /* cache is best effort */
            }
          }
          return json(res, 200, payload)
        } catch (err) {
          return json(res, 502, { error: 'lookup failed', detail: String(err) })
        }
      })

      server.middlewares.use('/api/analyze', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://local')
        const lat = Number(url.searchParams.get('lat'))
        const lon = Number(url.searchParams.get('lon'))
        const slug = (url.searchParams.get('slug') ?? '').replace(/[^a-zA-Z0-9_.-]/g, '')
        const name = url.searchParams.get('name') ?? 'This place'
        const years = (url.searchParams.get('years') ?? '')
          .split(',')
          .map((y) => y.trim())
          .filter((y) => /^\d{4}$/.test(y) && Number(y) >= 1999 && Number(y) <= 2026)
          .join(',')

        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !slug) {
          return json(res, 400, { error: 'lat, lon and slug are required' })
        }

        const argv = [
          path.join('pipeline', 'analyze.py'), '--lat', String(lat), '--lon', String(lon),
          '--slug', slug, '--name', name,
        ]
        if (years) argv.push('--years', years)

        const child = spawn(process.platform === 'win32' ? 'python' : 'python3', argv, {
          cwd: root,
          env: process.env,
        })

        let stderr = ''
        child.stderr.on('data', (d) => {
          stderr += d.toString()
          server.config.logger.info(`[analyze] ${d.toString().trim()}`)
        })

        child.on('close', async (code) => {
          if (code !== 0) return json(res, 502, { error: 'analysis failed', detail: stderr.slice(-800) })
          try {
            const body = await readFile(path.join(root, 'public', 'sites', `${slug}.json`), 'utf8')
            res.setHeader('content-type', 'application/json')
            res.setHeader('cache-control', 'no-store')
            res.end(body)
          } catch (err) {
            json(res, 500, { error: String(err) })
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), analyzeApi()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: { port: 5175, strictPort: false },
})
