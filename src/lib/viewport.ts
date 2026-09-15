/**
 * Whether the viewport is a phone's: under Tailwind's `sm` breakpoint
 * (640 px), the width at which the interface changes shape – the panel
 * and the cards become a sheet at the foot of the screen, the rail and
 * the readings move to the top (see App.tsx), and what has no place on
 * a phone leaves: the line diagram, which lays its rows out for a wide
 * screen, the photo mode and full screen. The markup does that with
 * `max-sm:` variants; this is for the few decisions that are state
 * rather than style – the panel opening folded, a link's `view=linear`
 * being read as the map, a card's fold button and its action standing
 * in the head rather than the body (CardShell in card-parts.tsx, where
 * the DOM differs and not just the style). Read at the moment asked,
 * never watched: a phone does not become a desktop mid-session.
 */
export function narrowViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 639.9px)').matches
  )
}
