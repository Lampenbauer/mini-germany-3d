import { describe, expect, it } from 'vitest'
import {
  WATER_CLAMP_RULES,
  judgeWaterPick,
  resetWaterClamp,
  waterCellKey,
  type WaterClampState,
} from '@/map/water-clamp'

/**
 * A pick off the tiles under a hull is water only where a reference
 * admits it – the hull's own level, a known water level, the
 * neighbours' floor – and a pick standing too high over every one of
 * them is held: a photographed twin's deck, a bridge (see water-clamp.ts).
 */

const none = { known: null, neighbours: null }
const coast = { known: 37.75, neighbours: null }

function fresh(): WaterClampState {
  return { clampedHeight: null, provisional: false, fine: false, heldHeight: null, heldPicks: 0 }
}

/** A pick read fine, at a hull at rest (a tile generation) or after a move. */
const at = (height: number, moved = false) => ({ height, moved, fine: true })
/** A pick read off coarse tiles – far from the camera, or while they load. */
const coarse = (height: number, moved = false) => ({ height, moved, fine: false })

describe('judgeWaterPick', () => {
  it('takes any pick where nothing is known to judge it by, provisionally', () => {
    const state = fresh()
    expect(judgeWaterPick(state, at(105), none)).toBe('accepted')
    expect(state).toMatchObject({ clampedHeight: 105, provisional: true, fine: true })
    // Still nothing to judge by: her own level vouches, a rise within a step is water
    expect(judgeWaterPick(state, at(107), none)).toBe('accepted')
    expect(state.provisional).toBe(true)
  })

  it('holds a first pick that stands over the known water, and takes one within its band', () => {
    const state = fresh()
    // A box ship's deck at the berth: 20 m over the tide
    expect(judgeWaterPick(state, at(58), coast)).toBe('held')
    expect(state.clampedHeight).toBeNull()
    // Read again at the next generation, same spot: held, nothing counted
    expect(judgeWaterPick(state, at(58), coast)).toBe('held')
    expect(state.heldPicks).toBe(0)
    // The tide's range and the mesh's undulation are inside the band
    expect(judgeWaterPick(state, at(37.75 + WATER_CLAMP_RULES.aboveM), coast)).toBe('accepted')
    // The mesh's water sags under the level by more than it rises over it
    expect(judgeWaterPick(fresh(), at(37.75 - WATER_CLAMP_RULES.belowM), coast)).toBe('accepted')
    // A coarse tile further under is turned away
    expect(judgeWaterPick(fresh(), at(37.75 - WATER_CLAMP_RULES.belowM - 1), coast)).toBe('held')
  })

  it('confirms nothing against a known level: a quay run along is never her water', () => {
    const state = fresh()
    judgeWaterPick(state, at(38, true), coast)
    for (let i = 0; i < 2 * WATER_CLAMP_RULES.confirmPicks; i++) {
      expect(judgeWaterPick(state, at(47 + (i % 2) * 0.5, true), coast)).toBe('held')
    }
    expect(state).toMatchObject({ clampedHeight: 38, heldPicks: 0 })
  })

  it('keeps a hull on her water under a bridge and lets her down again past it', () => {
    const state = fresh()
    judgeWaterPick(state, at(38, true), none)
    // The deck, 15 m up: held; her level stands
    expect(judgeWaterPick(state, at(53, true), none)).toBe('held')
    expect(state.clampedHeight).toBe(38)
    // The water on the other side, a shade higher: a small rise is water
    expect(judgeWaterPick(state, at(38.5, true), none)).toBe('accepted')
    expect(state.heldHeight).toBeNull()
    // A fall is always the water
    expect(judgeWaterPick(state, at(30, true), none)).toBe('accepted')
  })

  it('confirms a higher level once picks along her way agree on it – a lock, not a bridge', () => {
    const state = fresh()
    judgeWaterPick(state, at(90, true), none)
    const lifted = 90 + 4.5
    const { confirmPicks } = WATER_CLAMP_RULES
    for (let i = 1; i < confirmPicks; i++) {
      expect(judgeWaterPick(state, at(lifted + 0.1 * i, true), none)).toBe('held')
    }
    expect(state.clampedHeight).toBe(90)
    expect(judgeWaterPick(state, at(lifted - 0.2, true), none)).toBe('confirmed')
    expect(state).toMatchObject({ clampedHeight: lifted - 0.2, heldPicks: 0, fine: true })
    // Two decks in a row, then water: the count starts over for a level that differs
    const bridges = fresh()
    judgeWaterPick(bridges, at(38, true), none)
    judgeWaterPick(bridges, at(53, true), none)
    judgeWaterPick(bridges, at(53, true), none)
    expect(judgeWaterPick(bridges, at(70, true), none)).toBe('held')
    expect(bridges.heldPicks).toBe(1)
    expect(judgeWaterPick(bridges, at(38.2, true), none)).toBe('accepted')
  })

  it('never confirms from re-reads of the same spot: a hull on her twin stays off its deck', () => {
    const state = fresh()
    for (let i = 0; i < 10; i++) expect(judgeWaterPick(state, at(58), coast)).toBe('held')
    expect(state.clampedHeight).toBeNull()
    expect(state.heldPicks).toBe(0)
  })

  it('lets the neighbours’ floor admit a pick from above by the tolerance, and anything below it', () => {
    const inland = { known: null, neighbours: 90 }
    expect(judgeWaterPick(fresh(), at(93.9), inland)).toBe('accepted')
    expect(judgeWaterPick(fresh(), at(95), inland)).toBe('held')
    expect(judgeWaterPick(fresh(), at(80), inland)).toBe('accepted')
  })

  it('drops a provisional level once a neighbours’ floor turns its pick away, and clears it once one admits', () => {
    // The first hull picked after the city arrived stood on her twin's deck
    const state = fresh()
    judgeWaterPick(state, at(110), none)
    expect(judgeWaterPick(state, at(110), { known: null, neighbours: 90 })).toBe('held')
    expect(state).toMatchObject({ clampedHeight: null, provisional: false })
    // The first hull picked was on the water; the floor that appears agrees
    const water = fresh()
    judgeWaterPick(water, at(90.5), none)
    expect(judgeWaterPick(water, at(90.5), { known: null, neighbours: 90 })).toBe('accepted')
    expect(water.provisional).toBe(false)
    // A provisional level metres low: the floor lifts her where her own level would not
    const low = fresh()
    judgeWaterPick(low, at(85), none)
    expect(judgeWaterPick(low, at(90.5), { known: null, neighbours: 90 })).toBe('accepted')
  })

  it('lets a level read off coarse tiles vouch for nothing: the fine tile lifts her', () => {
    // Far from the camera the tiles put her 8 m under the water; near, the
    // true pick would be a rise her own level holds back – were it trusted
    const state = fresh()
    expect(judgeWaterPick(state, coarse(82), none)).toBe('accepted')
    expect(state.fine).toBe(false)
    expect(judgeWaterPick(state, at(90), none)).toBe('accepted')
    expect(state).toMatchObject({ clampedHeight: 90, fine: true })
    // Trusted now: a twin's deck is held
    expect(judgeWaterPick(state, at(110), none)).toBe('held')
    // And a coarse read never holds a fine one down on the coast either
    const far = fresh()
    judgeWaterPick(far, coarse(33), coast)
    expect(judgeWaterPick(far, at(39), coast)).toBe('accepted')
  })

  it('admits a rise at rest where the known water does, though the hull’s own level would not', () => {
    // The first pick came off a tile a little low; the fine one lifts the
    // water by more than a step – the tide's band takes it
    const state = fresh()
    judgeWaterPick(state, at(34), coast)
    expect(judgeWaterPick(state, at(38.5), coast)).toBe('accepted')
  })

  it('forgets everything on a reset', () => {
    const state = fresh()
    judgeWaterPick(state, at(38, true), none)
    judgeWaterPick(state, at(53, true), none)
    resetWaterClamp(state)
    expect(state).toEqual(fresh())
  })
})

describe('waterCellKey', () => {
  it('puts positions a cell apart in different cells, and near ones together, squared up by latitude', () => {
    const lat = 53.54
    const lon = 9.97
    const latDeg = WATER_CLAMP_RULES.cellM / 111_132
    const lonDeg = latDeg / Math.cos((lat * Math.PI) / 180)
    expect(waterCellKey(lon, lat)).toBe(waterCellKey(lon + lonDeg * 0.01, lat + latDeg * 0.01))
    expect(waterCellKey(lon, lat)).not.toBe(waterCellKey(lon, lat + latDeg * 1.01))
    expect(waterCellKey(lon, lat)).not.toBe(waterCellKey(lon + lonDeg * 1.01, lat))
  })
})
