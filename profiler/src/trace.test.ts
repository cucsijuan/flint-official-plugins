import { describe, expect, it } from 'vitest'
import { formatDuration, parseTrace, rangeStats, zoneAt } from './trace'

const trace = {
  traceEvents: [
    { ph: 'M', name: 'thread_name', pid: 1, tid: 10, args: { name: 'Game' } },
    { ph: 'M', name: 'thread_name', pid: 1, tid: 20, args: { name: 'Render' } },
    { ph: 'i', name: 'Frame', pid: 1, tid: 10, ts: 0 },
    { ph: 'X', name: 'Tick', cat: 'game', pid: 1, tid: 10, ts: 0, dur: 100 },
    { ph: 'X', name: 'Physics', cat: 'physics', pid: 1, tid: 10, ts: 10, dur: 40 },
    { ph: 'X', name: 'Solve', cat: 'physics', pid: 1, tid: 10, ts: 20, dur: 10 },
    { ph: 'X', name: 'AI', cat: 'ai', pid: 1, tid: 10, ts: 60, dur: 30, args: { agents: 12 } },
    { ph: 'B', name: 'Draw', cat: 'render', pid: 1, tid: 20, ts: 5 },
    { ph: 'B', name: 'Shadows', cat: 'render', pid: 1, tid: 20, ts: 15 },
    { ph: 'E', pid: 1, tid: 20, ts: 35 },
    { ph: 'E', pid: 1, tid: 20, ts: 80 },
    { ph: 'i', name: 'Frame', pid: 1, tid: 10, ts: 100 },
  ],
}

describe('parseTrace', () => {
  const capture = parseTrace(trace)

  it('names threads and stacks nested zones', () => {
    expect(capture.tracks.map((track) => track.name)).toEqual(['Game', 'Render'])
    const game = capture.tracks[0]
    expect(game.rows.map((row) => row.map((zone) => zone.name))).toEqual([
      ['Tick'],
      ['Physics', 'AI'],
      ['Solve'],
    ])
    expect(game.rows[1][1].args).toEqual({ agents: 12 })
  })

  it('pairs begin and end events', () => {
    const render = capture.tracks[1]
    expect(
      render.rows.map((row) => row.map((zone) => `${zone.name} ${zone.start}-${zone.end}`)),
    ).toEqual([['Draw 5-80'], ['Shadows 15-35']])
  })

  it('collects categories, frames and the time span', () => {
    expect(capture.categories).toEqual(['ai', 'game', 'physics', 'render'])
    expect(capture.frames).toEqual([0, 100])
    expect([capture.start, capture.end]).toEqual([0, 100])
  })

  it('finds zones by time and totals a range', () => {
    const [, physicsRow] = capture.tracks[0].rows
    expect(zoneAt(physicsRow, 30)?.name).toBe('Physics')
    expect(zoneAt(physicsRow, 55)).toBeNull()
    const stats = rangeStats(capture.tracks, 0, 50)
    expect(stats[0]).toEqual({ name: 'Tick', time: 50, count: 1 })
    expect(stats.find((entry) => entry.name === 'Draw')?.time).toBe(45)
  })

  it('accepts a plain event array', () => {
    expect(parseTrace([{ ph: 'X', name: 'A', ts: 1, dur: 2 }]).tracks).toHaveLength(1)
  })
})

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration(0.25)).toBe('250 ns')
    expect(formatDuration(450)).toBe('450 µs')
    expect(formatDuration(12_345)).toBe('12.3 ms')
    expect(formatDuration(1_200_000)).toBe('1.20 s')
  })
})
