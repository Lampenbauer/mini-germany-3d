import { describe, expect, it } from 'vitest'
import { CesiumMap } from '@/map/CesiumMap'

/**
 * Line-driven stop visibility: hiding lines hides exactly the stops no
 * shown line serves – stops shared with a still-visible line stay on the
 * map, and re-showing a line brings its stops back.
 */

interface FakeStop {
  lines: string[]
  lineVisible: boolean
  disc: { show: boolean }
  label: { show: boolean }
}

function makeStop(lines: string[]): FakeStop {
  return { lines, lineVisible: true, disc: { show: true }, label: { show: true } }
}

function harness(stops: FakeStop[]) {
  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    stopRecords: stops,
    stopLabelsDirty: false,
    renderRequested: false,
  })
  return map
}

describe('line-driven stop visibility', () => {
  it('hides exclusive stops, keeps shared ones, and restores on re-show', () => {
    const only1 = makeStop(['1'])
    const shared = makeStop(['1', '5'])
    const only5 = makeStop(['5'])
    const map = harness([only1, shared, only5])

    map.setVisibleLines(new Set(['5']))
    expect(only1.disc.show).toBe(false)
    expect(only1.label.show).toBe(false)
    expect(shared.disc.show).toBe(true)
    expect(only5.disc.show).toBe(true)

    map.setVisibleLines(new Set([]))
    expect(shared.disc.show).toBe(false)
    expect(only5.disc.show).toBe(false)

    map.setVisibleLines(new Set(['1']))
    expect(only1.disc.show).toBe(true)
    expect(only1.label.show).toBe(true)
    expect(shared.disc.show).toBe(true)
    expect(only5.disc.show).toBe(false)
  })

  it('marks the label declutter dirty only when something changed', () => {
    const stop = makeStop(['1'])
    const map = harness([stop])
    const internals = map as unknown as { stopLabelsDirty: boolean }

    map.setVisibleLines(new Set(['1']))
    expect(internals.stopLabelsDirty).toBe(false)

    map.setVisibleLines(new Set([]))
    expect(internals.stopLabelsDirty).toBe(true)
  })
})
