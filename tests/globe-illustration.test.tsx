// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GLOBE_FADE_MS, GlobeIllustration, globePicture } from '@/components/GlobeIllustration'
import { CITIES } from '@/cities/definitions'

/**
 * The globe on the rail (components/GlobeIllustration.tsx): the still
 * of the city for the ground a click brings, the dark map over the light
 * one as far as the night has come, and a crossfade to the next city.
 */

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('image')].map((image) => image.getAttribute('href'))
const cities = (container: HTMLElement) =>
  [...container.querySelectorAll('g[data-city]')].map((g) => g.getAttribute('data-city'))

afterEach(() => {
  vi.useRealTimers()
})

describe('the rail globe', () => {
  it('has all three pictures of every city in the build (scripts/build-globe-images.mjs)', () => {
    // The pictures in public/globe as the site serves them, by path
    const drawn = new Set(
      Object.keys(import.meta.glob('../public/globe/*.webp')).map((file) => file.slice('../public'.length)),
    )
    for (const city of CITIES) {
      for (const drawing of ['satellite', 'light', 'dark'] as const) {
        const file = globePicture(city.slug, drawing)
        expect(drawn.has(file), `${file} is missing – run the script`).toBe(true)
      }
    }
  })

  it('shows the street map by day, and only the light picture is asked for', () => {
    const { container } = render(<GlobeIllustration city="rostock" look="streets" night={0} />)
    expect(hrefs(container)).toEqual([globePicture('rostock', 'light')])
  })

  it('lays the dark map over the light one as far as the night has come', () => {
    const { container } = render(<GlobeIllustration city="rostock" look="streets" night={0.35} />)
    expect(hrefs(container)).toEqual([globePicture('rostock', 'light'), globePicture('rostock', 'dark')])
    expect(container.querySelectorAll('image')[1].getAttribute('opacity')).toBe('0.35')
    // A ramp value off its range is clamped
    const full = render(<GlobeIllustration city="rostock" look="streets" night={3} />).container
    expect(full.querySelectorAll('image')[1].getAttribute('opacity')).toBe('1')
  })

  it('shows the satellite picture for the photo look, day or night', () => {
    const { container } = render(<GlobeIllustration city="kiel" look="photo" night={1} />)
    expect(hrefs(container)).toEqual([globePicture('kiel', 'satellite')])
  })

  it('fades the next city in over the one left behind, and drops that one after', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <GlobeIllustration city="rostock" look="streets" night={0} />,
    )
    expect(cities(container)).toEqual(['rostock'])
    rerender(<GlobeIllustration city="berlin" look="streets" night={0} />)
    // Both on the disc: Rostock beneath, Berlin fading in on top
    expect(cities(container)).toEqual(['rostock', 'berlin'])
    const arriving = container.querySelectorAll('g[data-city]')[1]
    expect(arriving.getAttribute('class')).toContain('starting:opacity-0')
    // The fade ended: the city left behind goes
    fireEvent.transitionEnd(arriving)
    expect(cities(container)).toEqual(['berlin'])

    // Where no transition fires, the same after the fade's time
    rerender(<GlobeIllustration city="munich" look="streets" night={0} />)
    expect(cities(container)).toEqual(['berlin', 'munich'])
    act(() => {
      vi.advanceTimersByTime(GLOBE_FADE_MS + 100)
    })
    expect(cities(container)).toEqual(['munich'])
  })
})
