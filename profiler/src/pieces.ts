import type { ZoneSource } from './timeline'
import type { Track, Zone } from './trace'

/** What split_trace.py writes: the capture's outline and the list of its pieces. */
export interface Manifest {
  format: 'flint-profile'
  version: number
  start: number
  end: number
  chunkDuration: number
  overviewBucket: number
  names: string[]
  categories: string[]
  frames: number[]
  tracks: { name: string; sortIndex: number; depth: number; overview: number[] }[]
  chunks: { file: string; start: number; end: number; zones: number }[]
}

/** A zone in a piece: track, start, end, depth, name index, category index, and maybe args. */
type PieceZone = [number, number, number, number, number, number, Record<string, unknown>?]

export const isManifest = (json: unknown): json is Manifest =>
  typeof json === 'object' &&
  json !== null &&
  (json as { format?: unknown }).format === 'flint-profile'

/** More pieces than this in view and the timeline shows the overview instead of zones. */
const MAX_PIECES_IN_VIEW = 40
/** Zones kept in memory before pieces far from the view are dropped. */
const ZONE_BUDGET = 1_500_000
const PARALLEL_LOADS = 4

export interface OverviewTrack extends Track {
  /** Busy share of each overview bucket, from 0 to 1. */
  overview: number[]
}

/** A capture split into pieces: loads the ones in view and drops faraway ones. */
export class PieceSource implements ZoneSource {
  readonly start: number
  readonly end: number
  readonly categories: string[]
  readonly frames: number[]
  readonly tracks: OverviewTrack[]
  readonly overviewBucket: number
  private readonly listeners = new Set<() => void>()
  private readonly loaded = new Map<number, Zone[]>()
  private readonly loading = new Set<number>()
  private readonly queue: number[] = []
  private readonly refs = new Map<string, { zone: Zone; count: number }>()
  private readonly keys = new WeakMap<Zone, string>()
  /** Track positions in the manifest, in display order. */
  private readonly order: number[]
  private zoneCount = 0
  private view = { from: 0, to: 0 }

  constructor(
    private readonly manifest: Manifest,
    private readonly read: (file: string) => Promise<string>,
  ) {
    this.start = manifest.start
    this.end = manifest.end
    this.categories = manifest.categories.filter(Boolean).sort()
    this.frames = manifest.frames
    this.overviewBucket = manifest.overviewBucket
    this.tracks = manifest.tracks.map((track, index) => ({
      id: String(index),
      name: track.name,
      sortIndex: track.sortIndex,
      rows: Array.from({ length: Math.max(track.depth, 1) }, (): Zone[] => []),
      overview: track.overview,
    }))
    this.order = this.tracks.map((_, index) => index)
    this.order.sort((a, b) => this.tracks[a].sortIndex - this.tracks[b].sortIndex)
    this.tracks = this.order.map((index) => this.tracks[index])
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  hasDetail(from: number, to: number) {
    return (to - from) / this.manifest.chunkDuration <= MAX_PIECES_IN_VIEW
  }

  get status() {
    const waiting = this.loading.size + this.queue.length
    return waiting ? `Loading ${waiting} ${waiting === 1 ? 'piece' : 'pieces'}…` : ''
  }

  /** The pieces overlapping `[from, to)`, by index. */
  private piecesIn(from: number, to: number) {
    const { chunks } = this.manifest
    let low = 0
    let high = chunks.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (chunks[middle].end <= from) low = middle + 1
      else high = middle
    }
    const found: number[] = []
    for (let index = low; index < chunks.length && chunks[index].start < to; index++)
      found.push(index)
    return found
  }

  request(from: number, to: number) {
    this.view = { from, to }
    if (!this.hasDetail(from, to)) return
    const margin = (to - from) * 0.5
    const wanted = this.piecesIn(from - margin, to + margin)
    this.queue.length = 0
    for (const index of wanted) {
      if (!this.loaded.has(index) && !this.loading.has(index)) this.queue.push(index)
    }
    this.pump()
  }

  private pump() {
    while (this.loading.size < PARALLEL_LOADS && this.queue.length) {
      const index = this.queue.shift() as number
      this.loading.add(index)
      void this.load(index).finally(() => {
        this.loading.delete(index)
        this.pump()
        this.notify()
      })
    }
  }

  private async load(index: number) {
    const piece = JSON.parse(await this.read(this.manifest.chunks[index].file)) as {
      zones: PieceZone[]
    }
    const dirty = new Set<Zone[]>()
    const zones: Zone[] = []
    for (const [trackIndex, start, end, depth, name, category, args] of piece.zones) {
      const key = `${trackIndex}:${start}:${depth}`
      const known = this.refs.get(key)
      if (known) {
        known.count++
        zones.push(known.zone)
        continue
      }
      const zone: Zone = {
        start,
        end,
        depth,
        name: this.manifest.names[name] ?? '',
        category: this.manifest.categories[category] ?? '',
        ...(args ? { args } : {}),
      }
      this.refs.set(key, { zone, count: 1 })
      this.keys.set(zone, key)
      zones.push(zone)
      const track = this.tracks[this.order.indexOf(trackIndex)]
      const row = (track.rows[depth] ??= [])
      row.push(zone)
      dirty.add(row)
      this.zoneCount++
    }
    for (const row of dirty) row.sort((a, b) => a.start - b.start)
    this.loaded.set(index, zones)
    this.evict()
  }

  /** Drops the pieces farthest from the view until the zones fit the budget again. */
  private evict() {
    if (this.zoneCount <= ZONE_BUDGET) return
    const center = (this.view.from + this.view.to) / 2
    const distance = (index: number) => {
      const chunk = this.manifest.chunks[index]
      return Math.abs((chunk.start + chunk.end) / 2 - center)
    }
    const farthest = [...this.loaded.keys()].sort((a, b) => distance(b) - distance(a))
    const removed = new Set<Zone>()
    for (const index of farthest) {
      if (this.zoneCount <= ZONE_BUDGET * 0.8) break
      for (const zone of this.loaded.get(index) ?? []) {
        const key = this.keys.get(zone) ?? ''
        const entry = this.refs.get(key)
        if (!entry || --entry.count > 0) continue
        this.refs.delete(key)
        removed.add(zone)
        this.zoneCount--
      }
      this.loaded.delete(index)
    }
    if (!removed.size) return
    for (const track of this.tracks) {
      track.rows = track.rows.map((row) => row.filter((zone) => !removed.has(zone)))
    }
  }
}
