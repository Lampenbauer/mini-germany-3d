/**
 * The curve a ship or an aircraft is drawn along between two recorded
 * fixes. The fixes are seconds to a minute apart, and a straight chord
 * between them turns every curve into a polygon: the speed steps and the
 * direction kinks at each fix, which the layers' short ease only rounds
 * off. A cubic Hermite curve through the two fixes with the reported
 * course at each as its tangent – a ship's course over the ground, an
 * aircraft's track – draws the turn the vehicle actually made, and its
 * tangent is a direction of motion that changes smoothly.
 *
 * The tangents are given the chord's length: a unit-speed curve, which
 * bulges by the angle between the courses and the chord and never
 * overshoots. A course that points more than a right angle away from
 * the chord is not trusted (a ship going astern, a stale track) and the
 * chord's own direction stands in for it; two chord directions make the
 * curve the chord again.
 */

export interface CurvePoint {
  /** Meters east and north of the first fix. */
  eastM: number
  northM: number
  /** The direction of motion there, degrees clockwise from north. */
  tangentDeg: number
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function azimuthDeg(eastM: number, northM: number): number {
  return ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
}

/**
 * Whether the curve takes a course as its tangent: reported, and no more
 * than a right angle off the chord – beyond, it is not a direction of
 * motion between the two fixes.
 */
export function followsCourse(eastM: number, northM: number, deg: number | null): boolean {
  if (deg === null || (eastM === 0 && northM === 0)) return false
  return Math.abs(((deg - azimuthDeg(eastM, northM) + 540) % 360) - 180) <= 90
}

/**
 * The point `u` (0 at the first fix, 1 at the second) along the curve
 * from the origin to (eastM, northM), with the courses `fromDeg` and
 * `toDeg` as the tangent directions – null where a fix reported none.
 */
export function curvePoint(
  eastM: number,
  northM: number,
  fromDeg: number | null,
  toDeg: number | null,
  u: number,
): CurvePoint {
  const chord = Math.hypot(eastM, northM)
  const chordDeg = azimuthDeg(eastM, northM)
  const tangent = (deg: number | null): [number, number] => {
    if (deg === null || !followsCourse(eastM, northM, deg)) return [eastM, northM]
    return [chord * Math.sin(toRad(deg)), chord * Math.cos(toRad(deg))]
  }
  const [m0e, m0n] = tangent(fromDeg)
  const [m1e, m1n] = tangent(toDeg)
  const u2 = u * u
  const u3 = u2 * u
  // Hermite basis; the first fix is the origin, so h00 and d00 drop out
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  const east = h10 * m0e + h01 * eastM + h11 * m1e
  const north = h10 * m0n + h01 * northM + h11 * m1n
  // The derivative: the tangent, and the direction of motion
  const d10 = 3 * u2 - 4 * u + 1
  const d01 = -6 * u2 + 6 * u
  const d11 = 3 * u2 - 2 * u
  const dEast = d10 * m0e + d01 * eastM + d11 * m1e
  const dNorth = d10 * m0n + d01 * northM + d11 * m1n
  const tangentDeg =
    Math.hypot(dEast, dNorth) > 1e-6 ? azimuthDeg(dEast, dNorth) : chord > 0 ? chordDeg : 0
  return { eastM: east, northM: north, tangentDeg }
}
