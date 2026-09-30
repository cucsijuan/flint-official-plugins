/** A timed zone on one thread; times are in microseconds, like Trace Event JSON. */
export interface Zone {
  start: number
  end: number
  depth: number
  name: string
  category: string
  args?: Record<string, unknown>
}

export interface Track {
  /** `pid:tid`, unique across the capture. */
  id: string
  name: string
  sortIndex: number
  /** Zones by depth, each row sorted by start; zones in a row never overlap. */
  rows: Zone[][]
}

export interface Capture {
  start: number
  end: number
  tracks: Track[]
  categories: string[]
  /** Frame start times. */
  frames: number[]
}

interface TraceEvent {
  name?: string
  cat?: string
  ph?: string
  ts?: number
  dur?: number
  pid?: number | string
  tid?: number | string
  args?: Record<string, unknown>
}

export interface ParseOptions {
  /** Instant or complete events with this name mark frames. */
  frameMarker?: string
}

const trackId = (event: TraceEvent) => `${event.pid ?? 0}:${event.tid ?? 0}`

/** Stacks zones by nesting: a zone that starts inside another goes one row below it. */
export function stackRows(zones: Zone[]): Zone[][] {
  zones.sort((a, b) => a.start - b.start || b.end - a.end)
  const rows: Zone[][] = []
  const open: Zone[] = []
  for (const zone of zones) {
    while (open.length && open[open.length - 1].end <= zone.start) open.pop()
    zone.depth = open.length
    open.push(zone)
    ;(rows[zone.depth] ??= []).push(zone)
  }
  return rows
}

/** Reads Perfetto / Chrome Trace Event JSON: an array of events or `{ traceEvents: [...] }`. */
export function parseTrace(json: unknown, { frameMarker = 'Frame' }: ParseOptions = {}): Capture {
  const events: TraceEvent[] = Array.isArray(json)
    ? json
    : ((json as { traceEvents?: TraceEvent[] } | null)?.traceEvents ?? [])
  const zonesByTrack = new Map<string, Zone[]>()
  const threadNames = new Map<string, string>()
  const processNames = new Map<string, string>()
  const sortIndexes = new Map<string, number>()
  const openByTrack = new Map<string, TraceEvent[]>()
  const categories = new Set<string>()
  const frames: number[] = []
  let start = Infinity
  let end = -Infinity

  const addZone = (event: TraceEvent, zoneStart: number, zoneEnd: number) => {
    const category = event.cat ?? ''
    categories.add(category)
    const zones = zonesByTrack.get(trackId(event)) ?? []
    zones.push({
      start: zoneStart,
      end: Math.max(zoneEnd, zoneStart),
      depth: 0,
      name: event.name ?? '',
      category,
      ...(event.args && Object.keys(event.args).length ? { args: event.args } : {}),
    })
    zonesByTrack.set(trackId(event), zones)
    start = Math.min(start, zoneStart)
    end = Math.max(end, zoneEnd)
  }

  for (const event of events) {
    const ts = Number(event.ts ?? 0)
    switch (event.ph) {
      case 'X':
        addZone(event, ts, ts + Number(event.dur ?? 0))
        if (event.name === frameMarker) frames.push(ts)
        break
      case 'B': {
        const open = openByTrack.get(trackId(event)) ?? []
        open.push(event)
        openByTrack.set(trackId(event), open)
        break
      }
      case 'E': {
        const begin = openByTrack.get(trackId(event))?.pop()
        if (begin)
          addZone({ ...begin, args: { ...begin.args, ...event.args } }, Number(begin.ts ?? 0), ts)
        break
      }
      case 'i':
      case 'I':
        if (event.name === frameMarker) frames.push(ts)
        start = Math.min(start, ts)
        end = Math.max(end, ts)
        break
      case 'M': {
        const name = String(event.args?.name ?? '')
        if (event.name === 'thread_name') threadNames.set(trackId(event), name)
        if (event.name === 'process_name') processNames.set(String(event.pid ?? 0), name)
        if (event.name === 'thread_sort_index') {
          sortIndexes.set(trackId(event), Number(event.args?.sort_index ?? 0))
        }
        break
      }
    }
  }

  const hasManyProcesses = new Set([...zonesByTrack.keys()].map((id) => id.split(':')[0])).size > 1
  const tracks: Track[] = [...zonesByTrack].map(([id, zones]) => {
    const [pid, tid] = id.split(':')
    const thread = threadNames.get(id) ?? `Thread ${tid}`
    const process = processNames.get(pid) ?? `Process ${pid}`
    return {
      id,
      name: hasManyProcesses ? `${process} · ${thread}` : thread,
      sortIndex: sortIndexes.get(id) ?? (Number.isFinite(Number(tid)) ? Number(tid) : 0),
      rows: stackRows(zones),
    }
  })
  tracks.sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name))
  frames.sort((a, b) => a - b)
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
    tracks,
    categories: [...categories].sort(),
    frames,
  }
}

/** The index of the first zone in a row that ends after `time` (rows are sorted and don't overlap). */
export function firstEndingAfter(row: Zone[], time: number) {
  let low = 0
  let high = row.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (row[middle].end <= time) low = middle + 1
    else high = middle
  }
  return low
}

/** The zone under `time` in a row, if any. */
export function zoneAt(row: Zone[], time: number): Zone | null {
  const zone = row[firstEndingAfter(row, time)]
  return zone && zone.start <= time ? zone : null
}

/** Inclusive time per zone name inside `[from, to)`, longest first. */
export function rangeStats(tracks: Track[], from: number, to: number) {
  const totals = new Map<string, { name: string; time: number; count: number }>()
  for (const track of tracks) {
    for (const row of track.rows) {
      for (let index = firstEndingAfter(row, from); index < row.length; index++) {
        const zone = row[index]
        if (zone.start >= to) break
        const time = Math.min(zone.end, to) - Math.max(zone.start, from)
        const total = totals.get(zone.name) ?? { name: zone.name, time: 0, count: 0 }
        total.time += time
        total.count += 1
        totals.set(zone.name, total)
      }
    }
  }
  return [...totals.values()].sort((a, b) => b.time - a.time)
}

/** A duration in microseconds as a short label: 12.3 ms, 450 µs, 1.20 s. */
export function formatDuration(microseconds: number) {
  const value = Math.abs(microseconds)
  if (value >= 1_000_000) return `${(microseconds / 1_000_000).toFixed(2)} s`
  if (value >= 1_000)
    return `${(microseconds / 1_000).toFixed(value >= 100_000 ? 0 : value >= 10_000 ? 1 : 2)} ms`
  if (value >= 1) return `${microseconds.toFixed(value >= 100 ? 0 : 1)} µs`
  return `${(microseconds * 1000).toFixed(0)} ns`
}
