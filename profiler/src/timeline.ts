import {
  type Capture,
  firstEndingAfter,
  formatDuration,
  rangeStats,
  type Track,
  type Zone,
  zoneAt,
} from './trace'

/** Where the timeline gets its zones: all in memory, or loaded piece by piece. */
export interface ZoneSource {
  start: number
  end: number
  categories: string[]
  frames: number[]
  /** Tracks with the rows known so far; a source may fill rows in as pieces load. */
  tracks: Track[]
  /** Asks for the zones of `[from, to)`; the source calls `onChange` once more of them are in. */
  request?: (from: number, to: number) => void
  onChange?: (listener: () => void) => void
  /** Whether zones can be shown for `[from, to)`; otherwise tracks show their overview. */
  hasDetail?: (from: number, to: number) => boolean
  /** Length of each overview bucket, for tracks that carry an `overview`. */
  overviewBucket?: number
  /** A short note about loading, shown in the toolbar. */
  status?: string
}

export function memorySource(capture: Capture): ZoneSource {
  return capture
}

const RULER_HEIGHT = 24
const HEADER_HEIGHT = 18
const ROW_HEIGHT = 16
const TRACK_GAP = 8
const MIN_LABEL_WIDTH = 30
const MAX_VISIBLE_HEIGHT = 560
const DRAG_THRESHOLD = 3
const ZOOM_STEP = 1.5
const PALETTE = [
  '#4e79a7',
  '#f28e2b',
  '#59a14f',
  '#e15759',
  '#b07aa1',
  '#76b7b2',
  '#edc948',
  '#ff9da7',
  '#9c755f',
  '#86bcb6',
  '#d37295',
  '#a0cbe8',
]

const hashOf = (text: string) =>
  [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)

interface Layout {
  track: Track
  top: number
  height: number
}

/** A zoomable, pannable timeline of one capture, drawn on a canvas. */
export class Timeline {
  readonly element: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly scroller: HTMLElement
  private readonly tooltip: HTMLElement
  private readonly stats: HTMLElement
  private readonly legend: HTMLElement
  private readonly status: HTMLElement
  /** Resolves theme colors, which are CSS variables like `light-dark(…)`, to plain colors. */
  private readonly probe: HTMLElement
  private viewStart: number
  private viewEnd: number
  private hidden = new Set<string>()
  private search = ''
  private selection: { from: number; to: number } | null = null
  private layouts: Layout[] = []
  private frameRequest = 0
  private readonly colors = new Map<string, string>()
  private readonly resize: ResizeObserver

  constructor(private readonly source: ZoneSource) {
    this.viewStart = source.start
    this.viewEnd = source.end > source.start ? source.end : source.start + 1
    source.categories.forEach((category, index) =>
      this.colors.set(category, PALETTE[index % PALETTE.length]),
    )

    this.element = element('div', 'profiler')
    const toolbar = element('div', 'profiler-toolbar')
    const search = Object.assign(element('input', 'profiler-search'), {
      type: 'search',
      placeholder: 'Find zones…',
    }) as HTMLInputElement
    search.addEventListener('input', () => {
      this.search = search.value.trim().toLowerCase()
      this.draw()
    })
    this.legend = element('div', 'profiler-legend')
    this.status = element('span', 'profiler-loading')
    toolbar.append(
      search,
      this.legend,
      this.status,
      button('−', 'Zoom out (S)', () => this.zoom(ZOOM_STEP)),
      button('+', 'Zoom in (W)', () => this.zoom(1 / ZOOM_STEP)),
      button('Fit', 'Show the whole capture (F)', () => this.fit()),
    )
    this.scroller = element('div', 'profiler-scroller')
    this.canvas = element('canvas', 'profiler-canvas') as HTMLCanvasElement
    this.canvas.tabIndex = 0
    this.scroller.append(this.canvas)
    this.tooltip = element('div', 'profiler-tooltip')
    this.tooltip.hidden = true
    this.stats = element('div', 'profiler-stats')
    this.stats.hidden = true
    this.probe = element('span', 'profiler-probe')
    this.element.append(toolbar, this.scroller, this.tooltip, this.stats, this.probe)

    this.renderLegend()
    this.listen()
    this.resize = new ResizeObserver(() => this.draw())
    this.resize.observe(this.scroller)
    source.onChange?.(() => this.draw())
    this.draw()
  }

  destroy() {
    this.resize.disconnect()
    cancelAnimationFrame(this.frameRequest)
  }

  private colorOf(zone: Zone) {
    const known = zone.category ? this.colors.get(zone.category) : undefined
    return known ?? PALETTE[Math.abs(hashOf(zone.name)) % PALETTE.length]
  }

  private renderLegend() {
    this.legend.replaceChildren(
      ...this.source.categories.filter(Boolean).map((category) => {
        const item = element('button', 'profiler-category')
        item.title = 'Show or hide this category'
        const swatch = element('span', 'profiler-swatch')
        swatch.style.background = this.colors.get(category) ?? ''
        item.append(swatch, category)
        item.classList.toggle('is-hidden', this.hidden.has(category))
        item.addEventListener('click', () => {
          if (this.hidden.has(category)) this.hidden.delete(category)
          else this.hidden.add(category)
          this.renderLegend()
          this.draw()
        })
        return item
      }),
    )
  }

  private get width() {
    return this.scroller.clientWidth
  }

  private timeAt(x: number) {
    return this.viewStart + (x / this.width) * (this.viewEnd - this.viewStart)
  }

  private xOf(time: number) {
    return ((time - this.viewStart) / (this.viewEnd - this.viewStart)) * this.width
  }

  private setView(start: number, end: number) {
    const span = Math.max(end - start, 0.001)
    const total = this.source.end - this.source.start
    const padding = total * 0.05
    const clampedStart = Math.min(
      Math.max(start, this.source.start - padding),
      this.source.end + padding - span,
    )
    this.viewStart = clampedStart
    this.viewEnd = clampedStart + span
    this.draw()
  }

  zoom(factor: number, anchorX = this.width / 2) {
    const anchor = this.timeAt(anchorX)
    this.setView(
      anchor - (anchor - this.viewStart) * factor,
      anchor + (this.viewEnd - anchor) * factor,
    )
  }

  private pan(pixels: number) {
    const delta = (pixels / this.width) * (this.viewEnd - this.viewStart)
    this.setView(this.viewStart + delta, this.viewEnd + delta)
  }

  fit() {
    this.setView(this.source.start, Math.max(this.source.end, this.source.start + 1))
  }

  /** The track and zone under a point of the canvas. */
  private hit(x: number, y: number): { track: Track; zone: Zone | null } | null {
    const layout = this.layouts.find(({ top, height }) => y >= top && y < top + height)
    if (!layout) return null
    const rowIndex = Math.floor((y - layout.top - HEADER_HEIGHT) / ROW_HEIGHT)
    const row = rowIndex >= 0 ? layout.track.rows[rowIndex] : undefined
    const zone = row ? zoneAt(row, this.timeAt(x)) : null
    return { track: layout.track, zone: zone && !this.hidden.has(zone.category) ? zone : null }
  }

  private listen() {
    const canvas = this.canvas
    const point = (event: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }

    canvas.addEventListener('wheel', (event) => {
      const { x } = point(event)
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        this.zoom(Math.pow(1.0015, event.deltaY), x)
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault()
        this.pan(event.shiftKey ? event.deltaY : event.deltaX)
      }
    })

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      const origin = point(event)
      const startView = [this.viewStart, this.viewEnd]
      const isSelecting = event.shiftKey
      let hasMoved = false
      const move = (moved: PointerEvent) => {
        const { x } = point(moved)
        if (!hasMoved && Math.abs(x - origin.x) < DRAG_THRESHOLD) return
        hasMoved = true
        if (isSelecting) {
          const [a, b] = [this.timeAt(origin.x), this.timeAt(x)]
          this.selection = { from: Math.min(a, b), to: Math.max(a, b) }
          this.draw()
          this.showStats()
        } else {
          const delta = ((origin.x - x) / this.width) * (startView[1] - startView[0])
          this.setView(startView[0] + delta, startView[1] + delta)
        }
      }
      const up = () => {
        canvas.removeEventListener('pointermove', move)
        canvas.removeEventListener('pointerup', up)
        if (!hasMoved && !isSelecting && this.selection) {
          this.selection = null
          this.stats.hidden = true
          this.draw()
        }
      }
      canvas.addEventListener('pointermove', move)
      canvas.addEventListener('pointerup', up)
    })

    canvas.addEventListener('mousemove', (event) => {
      if (event.buttons) return
      const { x, y } = point(event)
      const found = this.hit(x, y)
      if (!found?.zone) {
        this.tooltip.hidden = true
        return
      }
      const zone = found.zone
      const args = zone.args
        ? Object.entries(zone.args)
            .map(
              ([key, value]) =>
                `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
            )
            .join('\n')
        : ''
      this.tooltip.textContent = [
        zone.name,
        `${formatDuration(zone.end - zone.start)} · ${found.track.name}${zone.category ? ` · ${zone.category}` : ''}`,
        args,
      ]
        .filter(Boolean)
        .join('\n')
      this.tooltip.hidden = false
      const bounds = this.element.getBoundingClientRect()
      const left = Math.min(
        event.clientX - bounds.left + 12,
        bounds.width - this.tooltip.offsetWidth - 4,
      )
      this.tooltip.style.left = `${Math.max(0, left)}px`
      this.tooltip.style.top = `${event.clientY - bounds.top + 16}px`
    })
    canvas.addEventListener('mouseleave', () => (this.tooltip.hidden = true))

    canvas.addEventListener('dblclick', (event) => {
      const { x, y } = point(event)
      const zone = this.hit(x, y)?.zone
      if (!zone) return
      const margin = (zone.end - zone.start) * 0.1
      this.setView(zone.start - margin, zone.end + margin)
    })

    canvas.addEventListener('keydown', (event) => {
      const actions: Record<string, () => void> = {
        w: () => this.zoom(1 / ZOOM_STEP),
        s: () => this.zoom(ZOOM_STEP),
        a: () => this.pan(-this.width * 0.2),
        d: () => this.pan(this.width * 0.2),
        f: () => this.fit(),
      }
      const action = actions[event.key.toLowerCase()]
      if (!action || event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      action()
    })
  }

  private showStats() {
    if (!this.selection) return
    const { from, to } = this.selection
    const top = rangeStats(this.source.tracks, from, to).slice(0, 10)
    const heading = element('div', 'profiler-stats-heading')
    heading.textContent = `Selection: ${formatDuration(to - from)}`
    const list = element('table', 'profiler-stats-table')
    for (const entry of top) {
      const row = element('tr')
      row.append(cell(entry.name), cell(formatDuration(entry.time)), cell(`×${entry.count}`))
      list.append(row)
    }
    this.stats.replaceChildren(heading, list)
    this.stats.hidden = false
  }

  draw() {
    cancelAnimationFrame(this.frameRequest)
    this.frameRequest = requestAnimationFrame(() => this.paint())
  }

  private paint() {
    const width = this.width
    if (!width) return
    this.source.request?.(this.viewStart, this.viewEnd)
    this.status.textContent = this.source.status ?? ''
    let top = RULER_HEIGHT
    this.layouts = this.source.tracks.map((track) => {
      const height = HEADER_HEIGHT + Math.max(track.rows.length, 1) * ROW_HEIGHT + TRACK_GAP
      const layout = { track, top, height }
      top += height
      return layout
    })
    const height = top
    const ratio = window.devicePixelRatio || 1
    this.scroller.style.maxHeight = `${MAX_VISIBLE_HEIGHT}px`
    this.canvas.width = Math.round(width * ratio)
    this.canvas.height = Math.round(height * ratio)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    const context = this.canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const theme = {
      text: this.resolve('--text', '#222'),
      muted: this.resolve('--text-muted', '#777'),
      border: this.resolve('--border', '#ddd'),
      header: this.resolve('--background-secondary', '#f4f4f4'),
      accent: this.resolve('--accent', '#6d5dd3'),
    }
    context.clearRect(0, 0, width, height)
    context.font = '11px system-ui, sans-serif'
    context.textBaseline = 'middle'

    this.paintRuler(context, width, height, theme)
    for (const layout of this.layouts) this.paintTrack(context, layout, width, theme)

    if (this.selection) {
      const x0 = this.xOf(this.selection.from)
      const x1 = this.xOf(this.selection.to)
      context.fillStyle = withAlpha(theme.accent, 0.2)
      context.fillRect(x0, 0, x1 - x0, height)
      context.strokeStyle = theme.accent
      context.strokeRect(x0 + 0.5, 0.5, Math.max(x1 - x0 - 1, 0), height - 1)
    }
  }

  /** How busy a track is over time, drawn when there's too much in view to load its zones. */
  private paintOverview(
    context: CanvasRenderingContext2D,
    { top, height }: Layout,
    overview: number[],
    width: number,
    theme: Record<string, string>,
  ) {
    const bucket = this.source.overviewBucket ?? 1
    const area = height - HEADER_HEIGHT - TRACK_GAP
    const bottom = top + HEADER_HEIGHT + area
    context.fillStyle = withAlpha(theme.accent, 0.55)
    for (let x = 0; x < width; x++) {
      const from = Math.floor((this.timeAt(x) - this.source.start) / bucket)
      const to = Math.max(from + 1, Math.ceil((this.timeAt(x + 1) - this.source.start) / bucket))
      let busy = 0
      for (let index = Math.max(from, 0); index < Math.min(to, overview.length); index++) {
        busy = Math.max(busy, overview[index])
      }
      if (busy > 0) context.fillRect(x, bottom - busy * area, 1, busy * area)
    }
    context.fillStyle = theme.muted
    context.fillText('Zoom in to see zones', width - 130, top + HEADER_HEIGHT / 2)
  }

  private resolve(variable: string, fallback: string) {
    this.probe.style.color = `var(${variable}, ${fallback})`
    return getComputedStyle(this.probe).color
  }

  private paintRuler(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    theme: Record<string, string>,
  ) {
    const span = this.viewEnd - this.viewStart
    const rough = (span / width) * 100
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
    const step =
      [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ??
      rough
    context.fillStyle = theme.header
    context.fillRect(0, 0, width, RULER_HEIGHT)
    context.strokeStyle = theme.border
    context.fillStyle = theme.muted
    for (let tick = Math.ceil(this.viewStart / step) * step; tick <= this.viewEnd; tick += step) {
      const x = Math.round(this.xOf(tick)) + 0.5
      context.beginPath()
      context.moveTo(x, RULER_HEIGHT - 6)
      context.lineTo(x, RULER_HEIGHT)
      context.stroke()
      context.fillText(formatDuration(tick - this.source.start), x + 3, RULER_HEIGHT / 2)
    }
    context.strokeStyle = withAlpha(theme.accent, 0.4)
    const first = firstFrameAfter(this.source.frames, this.viewStart)
    for (let index = first; index < this.source.frames.length; index++) {
      const frame = this.source.frames[index]
      if (frame > this.viewEnd) break
      const x = Math.round(this.xOf(frame)) + 0.5
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, height)
      context.stroke()
    }
  }

  private paintTrack(
    context: CanvasRenderingContext2D,
    layout: Layout,
    width: number,
    theme: Record<string, string>,
  ) {
    const { track, top } = layout
    context.fillStyle = theme.header
    context.fillRect(0, top, width, HEADER_HEIGHT)
    context.fillStyle = theme.text
    context.fillText(track.name, 6, top + HEADER_HEIGHT / 2)
    const overview = (track as Track & { overview?: number[] }).overview
    if (overview && this.source.hasDetail && !this.source.hasDetail(this.viewStart, this.viewEnd)) {
      this.paintOverview(context, layout, overview, width, theme)
      return
    }
    track.rows.forEach((row, depth) => {
      const y = top + HEADER_HEIGHT + depth * ROW_HEIGHT
      let lastPixel = -1
      for (let index = firstEndingAfter(row, this.viewStart); index < row.length; index++) {
        const zone = row[index]
        if (zone.start > this.viewEnd) break
        if (this.hidden.has(zone.category)) continue
        const x0 = Math.max(this.xOf(zone.start), -1)
        const x1 = Math.min(this.xOf(zone.end), width + 1)
        const isMatch = !this.search || zone.name.toLowerCase().includes(this.search)
        context.globalAlpha = isMatch ? 1 : 0.2
        if (x1 - x0 < 1) {
          // Zones thinner than a pixel merge into one sliver per pixel.
          const pixel = Math.floor(x0)
          if (pixel === lastPixel) continue
          lastPixel = pixel
          context.fillStyle = this.colorOf(zone)
          context.fillRect(pixel, y, 1, ROW_HEIGHT - 1)
          continue
        }
        context.fillStyle = this.colorOf(zone)
        context.fillRect(x0, y, x1 - x0 - 0.5, ROW_HEIGHT - 1)
        if (x1 - x0 >= MIN_LABEL_WIDTH) {
          context.save()
          context.beginPath()
          context.rect(x0, y, x1 - x0, ROW_HEIGHT)
          context.clip()
          context.fillStyle = '#fff'
          context.fillText(zone.name, Math.max(x0, 0) + 4, y + ROW_HEIGHT / 2)
          context.restore()
        }
      }
      context.globalAlpha = 1
    })
  }
}

/** `rgb(r, g, b)` with an alpha channel. */
function withAlpha(color: string, alpha: number) {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3)
  return channels ? `rgba(${channels.join(', ')}, ${alpha})` : color
}

function firstFrameAfter(frames: number[], time: number) {
  let low = 0
  let high = frames.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (frames[middle] < time) low = middle + 1
    else high = middle
  }
  return low
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '') {
  const created = document.createElement(tag)
  if (className) created.className = className
  return created
}

function button(label: string, title: string, onClick: () => void) {
  const created = element('button', 'profiler-button')
  created.type = 'button'
  created.textContent = label
  created.title = title
  created.addEventListener('click', onClick)
  return created
}

function cell(text: string) {
  const created = element('td')
  created.textContent = text
  return created
}
