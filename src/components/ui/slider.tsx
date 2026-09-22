import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '@/lib/utils'

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  // The name goes on the thumb: that is the element with role="slider",
  // the one a screen reader (and a test's getByRole) names – on the root
  // it would sit on a bare span and name nothing.
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-valuetext': ariaValueText,
  origin,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /**
   * Where the fill starts from, in the slider's own units – the middle
   * of a slider that goes both ways (the time-lapse: rewind to the left
   * of real pace, faster to the right). Radix fills from `min`; given an
   * origin the fill runs from it to the value instead – the fill's near
   * end is what marks the origin, whichever side the thumb stands on.
   * For one thumb only.
   */
  origin?: number
}) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [value, defaultValue, min],
  )
  const percent = (v: number) => ((v - min) / (max - min)) * 100
  const fill =
    origin === undefined
      ? null
      : {
          left: `${Math.min(percent(origin), percent(_values[0]))}%`,
          right: `${100 - Math.max(percent(origin), percent(_values[0]))}%`,
        }

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-accent relative grow overflow-hidden rounded-full h-1.5 w-full"
      >
        {fill ? (
          <span data-slot="slider-range" className="bg-primary absolute h-full" style={fill} />
        ) : (
          <SliderPrimitive.Range
            data-slot="slider-range"
            className="bg-primary absolute h-full"
          />
        )}
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-valuetext={ariaValueText}
          className="border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
