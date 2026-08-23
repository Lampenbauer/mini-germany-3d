import { Color, ColorMaterialProperty, JulianDate, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { RoutesLayer, TUNNEL_VISIBILITY } from '@/map/RoutesLayer'
import { testAsymmetricTunnelNetworkJson, testTunnelNetworkJson } from './fixtures'

/**
 * Attention pulse on a line's route after "zoom to line": every piece's
 * material color is a CallbackProperty that scales the base alpha with a
 * cosine while the pulse runs (full → 0 → full per period). Evaluating
 * the material color therefore exercises the exact path Cesium's color
 * batch uses per rendered frame.
 */

interface AddedRoute {
  id?: string
  polyline?: { material?: ColorMaterialProperty }
}

let clockMs = 0

beforeEach(() => {
  clockMs = 50_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function harness() {
  const added: AddedRoute[] = []
  const viewer = {
    entities: {
      add: (options: AddedRoute) => {
        added.push(options)
        return options
      },
    },
    creditDisplay: { addStaticCredit: vi.fn() },
  } as unknown as Viewer
  // offline: keeps the ground-clamped route branch these tests inspect
  const layer = new RoutesLayer(viewer, { requestRender: vi.fn(), offline: true })
  // Line U: surface / tunnel / surface pieces; line V: an unrelated line
  layer.add(prepareNetwork(testTunnelNetworkJson))
  layer.add(prepareNetwork(testAsymmetricTunnelNetworkJson))

  const alpha = (id: string): number => {
    const entity = added.find((e) => e.id === id)!
    return (entity.polyline!.material!.color!.getValue(JulianDate.now()) as Color).alpha
  }
  return { layer, alpha }
}

describe('route attention pulse', () => {
  it('dips the opacity to ~0 mid-period and back to full at period ends', () => {
    const h = harness()
    h.layer.startPulse('U')

    expect(h.alpha('route:U:0:0')).toBeCloseTo(0.85, 5)

    clockMs += 375 // half a 750 ms period
    expect(h.alpha('route:U:0:0')).toBeCloseTo(0, 5)
    // Tunnel piece scales proportionally from its dimmed base
    expect(h.alpha('route:U:0:1')).toBeCloseTo(0, 5)

    clockMs += 375
    expect(h.alpha('route:U:0:0')).toBeCloseTo(0.85, 5)
    expect(h.alpha('route:U:0:1')).toBeCloseTo(0.85 * TUNNEL_VISIBILITY, 5)
  })

  it('returns the exact base colors when the duration is over', () => {
    const h = harness()
    h.layer.startPulse('U')
    clockMs += 375
    expect(h.alpha('route:U:0:0')).toBeCloseTo(0, 5)

    clockMs += 3000
    expect(h.alpha('route:U:0:0')).toBeCloseTo(0.85, 5)
    expect(h.alpha('route:U:0:1')).toBeCloseTo(0.85 * TUNNEL_VISIBILITY, 5)
    // The render()-driver clears the finished pulse
    h.layer.updatePulse()
    expect((h.layer as unknown as { routePulse: unknown }).routePulse).toBeNull()
  })

  it('fades all other lines out during the pulse and back in at its end', () => {
    const h = harness()
    h.layer.startPulse('U')

    // Mid-fade after 125 ms of the 250 ms ramp
    clockMs += 125
    expect(h.alpha('route:V:0:0')).toBeCloseTo(0.85 * 0.5, 5)

    // Fully hidden while the pulse runs
    clockMs += 250
    expect(h.alpha('route:V:0:0')).toBeCloseTo(0, 5)

    // Mid-fade back in shortly before the pulse ends
    clockMs = 50_000 + 3000 - 125
    expect(h.alpha('route:V:0:0')).toBeCloseTo(0.85 * 0.5, 5)

    // Base color once it is over
    clockMs = 50_000 + 3000
    expect(h.alpha('route:V:0:0')).toBeCloseTo(0.85, 5)
  })

  it('switching the pulse to another line swaps the roles immediately', () => {
    const h = harness()
    h.layer.startPulse('U')
    clockMs += 375

    h.layer.startPulse('V')
    clockMs += 375
    // V now pulses (dip), U is faded out as "other" line
    expect(h.alpha('route:V:0:0')).toBeCloseTo(0, 5)
    expect(h.alpha('route:U:0:0')).toBeCloseTo(0, 5)
    clockMs += 375
    expect(h.alpha('route:V:0:0')).toBeCloseTo(0.85, 5)
    expect(h.alpha('route:U:0:0')).toBeCloseTo(0, 5)
  })
})
