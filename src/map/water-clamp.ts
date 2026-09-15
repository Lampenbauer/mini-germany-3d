/**
 * Whether a height picked off the tiles under a hull is the water.
 *
 * The pick (CesiumMap.clampToSurface) answers with the highest thing at
 * the position, and over water nothing lies under the surface: a wrong
 * answer is always too HIGH – the deck of a ship Google photographed at
 * the berth the live one is at now, a bridge deck she is passing under,
 * a crane, the quay's edge – and never too low, unless the tile is
 * coarse (found 2026-09-15: Hamburg's box ships on their photographed
 * twins, a tug riding the Köhlbrandbrücke). So a pick is judged against
 * whatever reference water level is at hand, and one that stands too far
 * over it is held back: the hull keeps the level it had, or the
 * reference. No second pick is made for it – the judgement is a
 * comparison per answer.
 *
 * Three references, any one of which admits a pick as water:
 *
 * - the hull's own last accepted level (`clampedHeight`): a ship does not
 *   climb `riseM` in `CLAMP_MOVE_M` of way, and a fall is always the
 *   water, never a deck – but only a level read `fine` vouches, near the
 *   camera with the tiles loaded: a coarse tile answers metres UNDER the
 *   water (the buoys measured 9 m at 3 km), and a level read off one
 *   would hold the true water back as a rise, for good on a hull at rest;
 * - a known water level at the position: NHN 0 in a coastal city, a
 *   ferry's route profile – a band of `aboveM` over it, wide enough for
 *   the tide the mesh was photographed at and its undulation, narrow
 *   enough to turn a box ship's deck, a cruise ship's or any bridge
 *   away, and `belowM` under it, because the mesh's water sags: the
 *   Köhlbrand's middle reads five metres under NHN 0 (probed 2026-09-15)
 *   and a hull held on the reference would hover over it;
 * - the lowest level accepted for a neighbour in the same cell of
 *   `cellM` (inland, where no level is known), `aboveM` over it at most,
 *   read fine for the same reason: the water is flat, and a floor read
 *   off a coarse tile would turn every true pick away.
 *
 * A pick with no reference at all is water: there is nothing to judge it
 * by – but the level it gives is `provisional`, and once a neighbour's
 * floor exists it does not vouch for the next pick: the floor judges
 * that one, and a level the floor turns away is dropped with it, so the
 * first hulls picked after a city arrives, before any floor stands, can
 * still come down off a twin's deck.
 *
 * Inland, a held pick is not lost: while the ship travels on, picks
 * that agree on the higher level `confirmPicks` times in a row make it
 * her water – a lock lifts her into a reach kilometres long, a bridge
 * deck is crossed in one or two picks (the widest decks over the
 * cities' water, the Rhine bridges' 30–40 m, give two at a pick every
 * 25 m of way; the count asks for four, a hundred metres of deck) – but
 * a re-read of the same spot at a new tile generation confirms nothing,
 * or a hull at her berth on her photographed twin would talk herself
 * onto its deck. Where the level is KNOWN nothing is ever confirmed: the
 * coast has no lock that lifts a ship out of the band, and a coaster
 * sent along Hamburg's car terminal quay reached three agreeing picks
 * on it before the water took her back (the same probe).
 *
 * Not caught, and known: a ship at rest INLAND, alone in her cell, on
 * her photographed twin – nothing is there to judge her first pick by,
 * and she takes the deck. A water-level grid from the terrain model
 * would close it (see CLAUDE.md, the AIS section).
 */

export const WATER_CLAMP_RULES = {
  /** Metres a pick may stand over a known water level, or over the neighbours' floor, and still be water. */
  aboveM: 4,
  /** Metres a pick may stand under a known water level and still be water – the mesh's sag. */
  belowM: 8,
  /** Metres a pick may rise over the hull's own accepted level in one step. */
  riseM: 3,
  /** Inland: picks in a row after a move that must agree on a higher level before it is taken. */
  confirmPicks: 4,
  /** Side of the cell whose lowest accepted level stands in for a reference inland. */
  cellM: 300,
} as const

export interface WaterClampState {
  /** The water level the hull rides – the last pick accepted; null until one is, the fallback. */
  clampedHeight: number | null
  /** Whether that level was taken with nothing to judge it by – a later floor may drop it. */
  provisional: boolean
  /** Whether it was read fine – near the camera, tiles loaded – and so vouches, and may serve as a floor. */
  fine: boolean
  /** A higher pick held back, and how many moved picks in a row agreed on it. */
  heldHeight: number | null
  heldPicks: number
}

export interface WaterPick {
  /** The height the pick answered. */
  height: number
  /** The pick followed a move of the hull, not a tile generation – only such picks count towards a confirmation. */
  moved: boolean
  /** Read near the camera with the tiles loaded (see WaterClampState.fine). */
  fine: boolean
}

export interface WaterReferences {
  /** A known water level at the position, or null. */
  known: number | null
  /** The lowest level accepted for a neighbour read off fine tiles, or null. */
  neighbours: number | null
}

export type WaterClampVerdict = 'accepted' | 'confirmed' | 'held'

/**
 * Judges one pick and writes the outcome into the state: `accepted` (a
 * reference admits it, or none exists), `confirmed` (held before, taken
 * now for having persisted along her way), `held` (kept off the hull).
 */
export function judgeWaterPick(
  state: WaterClampState,
  { height: pick, moved, fine }: WaterPick,
  references: WaterReferences,
): WaterClampVerdict {
  const { aboveM, belowM, riseM, confirmPicks } = WATER_CLAMP_RULES
  const { known, neighbours } = references
  const unjudged = known === null && neighbours === null
  // Her own level vouches only when read fine, and a level taken with
  // nothing to judge it by not once a neighbour's floor stands: the
  // floor judges that one
  const own =
    !state.fine || (state.provisional && neighbours !== null) ? null : state.clampedHeight
  const admitted =
    (own === null && unjudged) ||
    (own !== null && pick <= own + riseM) ||
    (known !== null && pick <= known + aboveM && pick >= known - belowM) ||
    (neighbours !== null && pick <= neighbours + aboveM)
  if (admitted) {
    accept(state, pick, fine)
    state.provisional = unjudged
    return 'accepted'
  }
  if (state.provisional && neighbours !== null) {
    // Turned away by the floor that has since appeared: the level goes
    // with the pick, and the hull rides the reference
    state.clampedHeight = null
    state.provisional = false
  }
  // Nothing is confirmed against a known level, and nothing at rest
  if (!moved || known !== null) return 'held'
  if (state.heldHeight !== null && Math.abs(pick - state.heldHeight) <= riseM) {
    state.heldPicks++
  } else {
    state.heldHeight = pick
    state.heldPicks = 1
  }
  if (state.heldPicks >= confirmPicks) {
    accept(state, pick, fine)
    return 'confirmed'
  }
  return 'held'
}

function accept(state: WaterClampState, pick: number, fine: boolean): void {
  state.clampedHeight = pick
  state.provisional = false
  state.fine = fine
  state.heldHeight = null
  state.heldPicks = 0
}

/** Forgets every judgement – the ground changed under the hull. */
export function resetWaterClamp(state: WaterClampState): void {
  state.clampedHeight = null
  state.provisional = false
  state.fine = false
  state.heldHeight = null
  state.heldPicks = 0
}

/**
 * The cell a position falls in for the neighbours' floor: `cellM` a
 * side, squared up by the latitude so a cell is as wide as it is tall.
 */
export function waterCellKey(lon: number, lat: number): string {
  const latDeg = WATER_CLAMP_RULES.cellM / 111_132
  const lonDeg = latDeg / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return `${Math.floor(lat / latDeg)}:${Math.floor(lon / lonDeg)}`
}
