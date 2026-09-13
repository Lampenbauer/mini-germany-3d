/**
 * The photo button in the camera block: the camera the city is shot with.
 *
 * Behind it sit the knobs a photographer would reach for – focal length,
 * exposure, white balance, then the picture's contrast, saturation and
 * vignette – and the miniature effect with its own set once it is on.
 * It sits with the camera controls rather than with the sky (see the
 * weather popover) because none of it is about the city: it is about
 * the lens and the sensor the city is looked at through.
 *
 * The state is the app's: the popover reports a whole settings object
 * for every turn of a knob (see lib/photo-settings.ts for what is in
 * it) and shows whatever it is handed back. The button lights up like
 * the weather button does whenever any knob stands off its default –
 * an adjusted picture is a state worth seeing from outside the popover –
 * and the reset button in the head of the popover puts every knob back
 * at once. The camera path is not in here: the button at the very end
 * opens it as a bar of its own over the foot of the map (see
 * CameraPathBar.tsx) – a dolly is composed looking at the picture.
 */

import { useId, type ReactNode } from 'react'
import { Aperture, Clapperboard, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger, usePopoverOpen } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { t, type MessageKey } from '@/lib/i18n'
import {
  DEFAULT_PHOTO_SETTINGS,
  DEFAULT_TILT_SHIFT_SETTINGS,
  focalLengthMm,
  isDefaultPhotoSettings,
  KNOB_RANGES,
  lensFovDeg,
  withTiltShift,
  type PhotoSettings,
  type TiltShiftSettings,
} from '@/lib/photo-settings'
import { cn } from '@/lib/utils'

export interface PhotoModePopoverProps {
  /** The interface is hidden (H, a dialog): the popover closes with it. */
  interfaceHidden: boolean
  settings: PhotoSettings
  onChange: (settings: PhotoSettings) => void
  /** Whether the camera path bar is up – the button at the end is pressed then. */
  cameraPathOpen: boolean
  onToggleCameraPath: () => void
  /** Extra classes for the trigger – the camera block styles its buttons as one group. */
  triggerClassName?: string
}

/** A number with its sign, the way a camera shows compensation: "+0.3", "−1". */
function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits)
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text
}

const percent = (value: number) => `${Math.round(value * 100)} %`

interface KnobProps {
  label: MessageKey
  value: number
  /** Where this knob stands untouched – a double click on its caption puts it back. */
  defaultValue: number
  /** The reading beside the name. */
  format: (value: number) => string
  min: number
  max: number
  step: number
  /** Right end is the low value – for a knob whose reading falls as the value rises. */
  inverted?: boolean
  onChange: (value: number) => void
}

/** One labelled knob: name and reading above, the slider below. */
function Knob(props: KnobProps) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      {/* A double click on the caption – the name or the reading – puts
          this one knob back where it started. The quickest way home from
          a slider pushed too far, and the only one that does not take the
          twelve others with it the way the reset button in the head does.
          select-none because a double click on a word otherwise selects
          it, and a highlighted label reads as an accident. */}
      <div
        className="text-muted-foreground flex cursor-default items-center justify-between text-xs select-none"
        title={t('photo.resetKnob')}
        onDoubleClick={() => {
          if (props.value !== props.defaultValue) props.onChange(props.defaultValue)
        }}
      >
        <span id={id}>{t(props.label)}</span>
        <span className="font-mono tabular-nums">{props.format(props.value)}</span>
      </div>
      <Slider
        aria-labelledby={id}
        min={props.min}
        max={props.max}
        step={props.step}
        inverted={props.inverted}
        value={[props.value]}
        onValueChange={([value]) => props.onChange(value)}
      />
    </div>
  )
}

function Section(props: { title: MessageKey; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t(props.title)}
      </div>
      {props.children}
    </div>
  )
}

export function PhotoModePopover(props: PhotoModePopoverProps) {
  const { settings } = props
  const adjusted = !isDefaultPhotoSettings(settings)
  const set = <K extends keyof PhotoSettings>(key: K, value: PhotoSettings[K]) =>
    props.onChange({ ...settings, [key]: value })
  const setTiltShift = <K extends keyof TiltShiftSettings>(key: K, value: TiltShiftSettings[K]) =>
    props.onChange({ ...settings, tiltShift: { ...settings.tiltShift, [key]: value } })

  const [open, setOpen] = usePopoverOpen(props.interfaceHidden)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                props.triggerClassName,
                adjusted && 'bg-primary/90 text-primary-foreground hover:bg-primary/80',
              )}
              aria-label={t('photo.title')}
            >
              <Aperture aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">{t('photo.title')}</TooltipContent>
      </Tooltip>
      {/* Thirteen knobs at most: taller than a small window, so the panel
          scrolls inside itself instead of growing past the top edge – the
          scroll area's ceiling is the window less the popover's distance
          from the edges (POPOVER_EDGE_PADDING, 16 px), its own padding
          (12 px) and its border (1 px), top and bottom: 58 px, and the
          fade says there is more below. */}
      <PopoverContent
        side="left"
        className="pointer-events-auto w-72"
      >
        <ScrollArea className="max-h-[calc(100dvh-3.625rem)]" viewportClassName="scroll-fade-y">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{t('photo.title')}</div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('photo.reset')}
                title={t('photo.reset')}
                disabled={!adjusted}
                onClick={() => props.onChange(DEFAULT_PHOTO_SETTINGS)}
              >
                <RotateCcw aria-hidden />
              </Button>
            </div>

            {/* The framing guides a phone camera offers – thirds, over the
                whole frame – right under the title, before the knobs: it
                is the first thing to switch on when composing a shot, and
                the only switch here that changes nothing about the
                picture – it is drawn by the interface and leaves with it,
                so a screenshot never catches it. */}
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('scene.grid')}</span>
              <Switch
                aria-label={t('scene.showGrid')}
                checked={settings.grid}
                onCheckedChange={(grid) => set('grid', grid)}
              />
            </div>

            <div className="bg-border h-px" role="separator" />

            <Section title="photo.camera">
              {/* The slider runs in degrees – that is what the lens is set
                  in, and it keeps the default angle on the grid – but reads
                  as a focal length, and is inverted so that right is the
                  longer lens, as a photographer expects. */}
              <Knob
                label="photo.focalLength"
                value={settings.fovDeg}
                // Back to the lens of the look on screen rather than to
                // the one the app opened with: the miniature effect is
                // built on the long lens and the switch below brings it
                // along (see withTiltShift), so with the effect turned
                // the other way its own lens is what "default" means.
                defaultValue={lensFovDeg(settings.tiltShift.enabled)}
                format={(fov) => `${Math.round(focalLengthMm(fov))} mm · ${Math.round(fov)}°`}
                {...KNOB_RANGES.fovDeg}
                inverted
                onChange={(fovDeg) => set('fovDeg', fovDeg)}
              />
              <Knob
                label="photo.exposure"
                defaultValue={DEFAULT_PHOTO_SETTINGS.exposureEv}
                value={settings.exposureEv}
                format={(ev) => `${signed(ev, 1)} EV`}
                {...KNOB_RANGES.exposureEv}
                onChange={(exposureEv) => set('exposureEv', exposureEv)}
              />
              <Knob
                label="photo.whiteBalance"
                defaultValue={DEFAULT_PHOTO_SETTINGS.whiteBalanceK}
                value={settings.whiteBalanceK}
                format={(kelvin) => `${kelvin} K`}
                {...KNOB_RANGES.whiteBalanceK}
                onChange={(whiteBalanceK) => set('whiteBalanceK', whiteBalanceK)}
              />
            </Section>

            <Section title="photo.look">
              <Knob
                label="photo.contrast"
                defaultValue={DEFAULT_PHOTO_SETTINGS.contrast}
                value={settings.contrast}
                format={(contrast) => signed(Math.round((contrast - 1) * 100), 0)}
                {...KNOB_RANGES.contrast}
                onChange={(contrast) => set('contrast', contrast)}
              />
              <Knob
                label="photo.saturation"
                defaultValue={DEFAULT_PHOTO_SETTINGS.saturation}
                value={settings.saturation}
                format={(saturation) => signed(Math.round((saturation - 1) * 100), 0)}
                {...KNOB_RANGES.saturation}
                onChange={(saturation) => set('saturation', saturation)}
              />
              <Knob
                label="photo.vignette"
                defaultValue={DEFAULT_PHOTO_SETTINGS.vignette}
                value={settings.vignette}
                format={percent}
                {...KNOB_RANGES.vignette}
                onChange={(vignette) => set('vignette', vignette)}
              />
            </Section>

            <div className="bg-border h-px" role="separator" />

            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('scene.tiltShift')}</span>
                {/* The switch brings the lens of its look along (see
                    withTiltShift) – the effect is built on the long one. */}
                <Switch
                  aria-label={t('scene.showTiltShift')}
                  checked={settings.tiltShift.enabled}
                  onCheckedChange={(enabled) => props.onChange(withTiltShift(settings, enabled))}
                />
              </div>
              {settings.tiltShift.enabled && (
                <>
                  <Knob
                    label="photo.blur"
                defaultValue={DEFAULT_TILT_SHIFT_SETTINGS.maxBlurRadius}
                    value={settings.tiltShift.maxBlurRadius}
                    format={(radius) => `${(radius * 100).toFixed(1)} %`}
                    {...KNOB_RANGES.maxBlurRadius}
                    onChange={(maxBlurRadius) => setTiltShift('maxBlurRadius', maxBlurRadius)}
                  />
                  <Knob
                    label="photo.band"
                defaultValue={DEFAULT_TILT_SHIFT_SETTINGS.bandHalfHeight}
                    value={settings.tiltShift.bandHalfHeight}
                    format={percent}
                    {...KNOB_RANGES.bandHalfHeight}
                    onChange={(bandHalfHeight) => setTiltShift('bandHalfHeight', bandHalfHeight)}
                  />
                  <Knob
                    label="photo.feather"
                defaultValue={DEFAULT_TILT_SHIFT_SETTINGS.bandFeather}
                    value={settings.tiltShift.bandFeather}
                    format={percent}
                    {...KNOB_RANGES.bandFeather}
                    onChange={(bandFeather) => setTiltShift('bandFeather', bandFeather)}
                  />
                  <Knob
                    label="photo.focusLine"
                defaultValue={DEFAULT_TILT_SHIFT_SETTINGS.focusY}
                    value={settings.tiltShift.focusY}
                    format={percent}
                    {...KNOB_RANGES.focusY}
                    onChange={(focusY) => setTiltShift('focusY', focusY)}
                  />
                  <Knob
                    label="photo.bokeh"
                defaultValue={DEFAULT_TILT_SHIFT_SETTINGS.highlightGain}
                    value={settings.tiltShift.highlightGain}
                    format={(gain) => `${gain.toFixed(1)}×`}
                    {...KNOB_RANGES.highlightGain}
                    onChange={(highlightGain) => setTiltShift('highlightGain', highlightGain)}
                  />
                  <Knob
                    label="photo.sharpen"
                defaultValue={DEFAULT_TILT_SHIFT_SETTINGS.sharpen}
                    value={settings.tiltShift.sharpen}
                    format={percent}
                    {...KNOB_RANGES.sharpen}
                    onChange={(sharpen) => setTiltShift('sharpen', sharpen)}
                  />
                </>
              )}
            </div>

            {/* The dolly (lib/camera-path.ts) opens as a bar of its own
                over the foot of the map (CameraPathBar.tsx) – it moves the
                camera rather than setting it, and a shot is composed
                looking at the picture, not at this column. Last, after
                the picture's knobs; pressed while the bar is up. */}
            <Button
              variant={props.cameraPathOpen ? 'secondary' : 'outline'}
              size="sm"
              className="justify-start"
              aria-pressed={props.cameraPathOpen}
              onClick={props.onToggleCameraPath}
            >
              <Clapperboard aria-hidden />
              {t('path.title')}
            </Button>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
