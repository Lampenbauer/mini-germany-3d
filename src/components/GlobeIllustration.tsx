import { useEffect, useId, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The look a globe wears: the ground a click on it switches to. The
 * street map is Mapbox's light map of the city by day and its dark one
 * at night, crossfaded along the same ramp the sky follows; the
 * photographed earth is the satellite picture. All three are stills of
 * the city from above (public/globe/, drawn once per city by
 * scripts/build-globe-images.mjs and committed – nothing is fetched
 * from Mapbox when the map runs), clipped to a disc with a rim of shade
 * so it reads as a sphere. No gloss and no border, deliberately: the
 * picture is the button.
 *
 * A city switch crossfades: the city left behind stays under the one
 * arriving while that one fades in over GLOBE_FADE_MS (@starting-style
 * – a browser without it shows the next city at once), and is dropped
 * when the fade has ended, or after the same time where no transition
 * fires (jsdom, a tab in the background).
 */
export type GlobeLook = 'streets' | 'photo'

/** The picture of a city in one of the three drawings, as the script names them. */
export function globePicture(city: string, drawing: 'satellite' | 'light' | 'dark'): string {
  return `/globe/${city}-${drawing}.webp`
}

/** How long the next city takes to fade in. */
export const GLOBE_FADE_MS = 500

/** The view box – any square; the pictures fill it. */
const SIZE = 200

const RIMS = {
  streets: { shade: 0.28 },
  photo: { shade: 0.4 },
} as const

export function GlobeIllustration(props: {
  /** The city on the map, by slug – the picture is that city's. */
  city: string
  look: GlobeLook
  /** 0 = day … 1 = full night: how much of the dark map shows over the light one. */
  night?: number
  className?: string
}) {
  const id = useId()
  const c = SIZE / 2
  const rim = RIMS[props.look]
  const night = Math.min(1, Math.max(0, props.night ?? 0))

  // The cities on the disc: the newest last, on top; an older one is
  // only ever the one being faded over
  const [layers, setLayers] = useState([{ city: props.city, key: 0 }])
  const newest = layers[layers.length - 1]
  useEffect(() => {
    if (newest.city === props.city) return
    setLayers([newest, { city: props.city, key: newest.key + 1 }])
  }, [props.city, newest])
  const settle = () => setLayers((current) => current.slice(-1))
  useEffect(() => {
    if (layers.length < 2) return
    const timer = window.setTimeout(settle, GLOBE_FADE_MS + 100)
    return () => window.clearTimeout(timer)
  }, [layers])

  const pictures = (city: string) =>
    props.look === 'photo' ? (
      <image
        href={globePicture(city, 'satellite')}
        width={SIZE}
        height={SIZE}
        preserveAspectRatio="xMidYMid slice"
      />
    ) : (
      <>
        <image
          href={globePicture(city, 'light')}
          width={SIZE}
          height={SIZE}
          preserveAspectRatio="xMidYMid slice"
        />
        {/* The dark map over the light one, as far as the night has come;
            left out entirely by day so the browser does not load it */}
        {night > 0 && (
          <image
            href={globePicture(city, 'dark')}
            width={SIZE}
            height={SIZE}
            preserveAspectRatio="xMidYMid slice"
            opacity={night}
          />
        )}
      </>
    )

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={cn('block', props.className)}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`${id}-disc`}>
          <circle cx={c} cy={c} r={c} />
        </clipPath>
        <radialGradient id={`${id}-shade`} cx="50%" cy="50%" r="50%">
          <stop offset="0.72" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity={rim.shade} />
        </radialGradient>
      </defs>
      <g clipPath={`url(#${id}-disc)`}>
        {layers.map((layer, index) => (
          <g
            key={layer.key}
            data-city={layer.city}
            className={cn(
              index > 0 && 'transition-opacity duration-500 ease-out starting:opacity-0',
            )}
            onTransitionEnd={index > 0 ? settle : undefined}
          >
            {pictures(layer.city)}
          </g>
        ))}
        <rect width={SIZE} height={SIZE} fill={`url(#${id}-shade)`} />
      </g>
    </svg>
  )
}
