/**
 * How the map separates what runs underground from what runs on the
 * surface – the one display convention the routes and the vehicles share.
 */

/**
 * Opacity of the ghosted half. Low enough to read as "somewhere else",
 * high enough to still follow a route or a vehicle through it. The E2E
 * tests pin the ghosting behaviour against this value.
 */
export const TUNNEL_VISIBILITY = 0.2

/**
 * Opacity factor for one piece of the network.
 *
 * The normal view ghosts what runs underground; the underground view flips
 * the roles and ghosts everything on the surface instead, so a tunnel
 * reads as clearly as a surface route does otherwise.
 */
export function tunnelOpacity(inTunnel: boolean, underground: boolean): number {
  return inTunnel === underground ? 1 : TUNNEL_VISIBILITY
}

/**
 * Opacity of a ghosted route line in the underground view.
 *
 * Lower than TUNNEL_VISIBILITY on purpose, because the backdrop changes
 * with the view: in the normal view a ghosted tunnel lies over a bright
 * city and reads as a faint tint, while in the underground view the same
 * value sits on a darkened city, where a saturated, unbroken line still
 * reads as fully drawn. Stops and vehicles do not need this – dots, plates
 * and badges recede on their own.
 */
const UNDERGROUND_ROUTE_VISIBILITY = 0.07

/** tunnelOpacity for the route polylines (see UNDERGROUND_ROUTE_VISIBILITY). */
export function routeTunnelOpacity(inTunnel: boolean, underground: boolean): number {
  if (inTunnel === underground) return 1
  return underground ? UNDERGROUND_ROUTE_VISIBILITY : TUNNEL_VISIBILITY
}
