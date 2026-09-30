import { describe, expect, it } from 'vitest'
import { type Manifest, PieceSource } from './pieces'

const manifest: Manifest = {
  format: 'flint-profile',
  version: 1,
  start: 0,
  end: 300,
  chunkDuration: 100,
  overviewBucket: 25,
  names: ['Tick', 'Long'],
  categories: ['game'],
  frames: [0, 100, 200],
  tracks: [{ name: 'Game', sortIndex: 0, depth: 2, overview: [1, 1, 0, 0] }],
  chunks: [
    { file: 'chunks/000000.json', start: 0, end: 100, zones: 2 },
    { file: 'chunks/000001.json', start: 100, end: 200, zones: 2 },
    { file: 'chunks/000002.json', start: 200, end: 300, zones: 1 },
  ],
}

// "Long" spans the first two pieces, so both hold it.
const pieces: Record<string, unknown> = {
  'chunks/000000.json': {
    zones: [
      [0, 0, 150, 0, 1, 0],
      [0, 10, 40, 1, 0, 0],
    ],
  },
  'chunks/000001.json': {
    zones: [
      [0, 0, 150, 0, 1, 0],
      [0, 110, 140, 1, 0, 0],
    ],
  },
  'chunks/000002.json': { zones: [[0, 210, 250, 0, 0, 0, { frame: 2 }]] },
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('PieceSource', () => {
  it('loads the pieces in view and shares zones that span pieces', async () => {
    const source = new PieceSource(manifest, async (file) => JSON.stringify(pieces[file]))
    source.request(0, 150)
    await settle()
    const [top, nested] = source.tracks[0].rows
    expect(top.map((zone) => zone.name)).toEqual(['Long', 'Tick'])
    expect(nested.map((zone) => zone.start)).toEqual([10, 110])
    expect(top.filter((zone) => zone.name === 'Long')).toHaveLength(1)
    expect(top[1].args).toEqual({ frame: 2 })
  })

  it('shows the overview when too much is in view', () => {
    const source = new PieceSource(manifest, async () => '{"zones":[]}')
    expect(source.hasDetail(0, 300)).toBe(true)
    expect(source.hasDetail(0, 100 * 41)).toBe(false)
  })
})
