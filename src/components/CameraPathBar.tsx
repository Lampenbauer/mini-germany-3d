/**
 * The camera path as its own small bar over the foot of the map – the
 * dolly (lib/camera-path.ts) as a strip of transport controls: the two
 * keyframes in one row with the seconds and the pace beside them, and
 * under them the timeline with play at its head. It sits centred above
 * the readings (the radio group at the foot), where a shot is composed
 * looking at the picture rather than at a column of knobs, and opens
 * from the button at the end of the photo popover.
 *
 * Until 2026-09-11 all of this was a section at the end of the photo
 * popover – a column of rows on the right edge, which covered a good
 * part of the frame the shot was being set up in. The state is the
 * app's, as the popover's is: every control reports, the bar shows what
 * it is handed.
 */

import { useId } from 'react'
import { Camera, Info, Play, RotateCcw, Square, X } from 'lucide-react'
import { Knob } from '@/components/PhotoModePopover'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CameraView } from '@/lib/camera-hash'
import {
  DEFAULT_DURATION_S,
  MIN_DURATION_S,
  describeKeyframe,
  formatPathTime,
  type CameraPathEase,
} from '@/lib/camera-path'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * The camera path as the bar drives it (see lib/camera-path.ts and the
 * handlers in App.tsx): two keyframes taken from the camera as it
 * stands, the seconds between them, the pace – and the flight itself.
 */
export interface CameraPathControls {
  start: CameraView | null
  end: CameraView | null
  durationS: number
  ease: CameraPathEase
  playing: boolean
  /** How far along the way the camera stands, 0..1 – the timeline's value. */
  progress: number
  onSetKeyframe: (which: 'start' | 'end') => void
  onGoTo: (which: 'start' | 'end') => void
  onDurationChange: (durationS: number) => void
  onEaseChange: (ease: CameraPathEase) => void
  onPlay: () => void
  onStop: () => void
  onScrub: (t: number) => void
  onClear: () => void
}

export interface CameraPathBarProps extends CameraPathControls {
  onClose: () => void
}

/** One face of the play button: its icon and its word. */
const PLAY_FACE = 'col-start-1 row-start-1 flex items-center gap-1.5'

/** The pose's text: two lines of monospace, or "not set". */
const POSE_TEXT = 'font-mono text-[10px] leading-tight tabular-nums whitespace-pre-line'

/** One keyframe: its name, the button that takes it, and where it stands. */
function Keyframe(props: {
  which: 'start' | 'end'
  view: CameraView | null
  onSet: () => void
  onGoTo: () => void
}) {
  const start = props.which === 'start'
  const setLabel = t(start ? 'path.setStart' : 'path.setEnd')
  const goLabel = t(start ? 'path.goStart' : 'path.goEnd')
  return (
    // flex-1: the two keyframes share whatever width the duration column
    // beside them leaves, so the row fills the bar at every width
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-muted-foreground text-xs select-none">
        {t(start ? 'path.start' : 'path.end')}
      </span>
      {/* The button that takes the keyframe, then where it stands. The
          pose itself is the way to it: a click on the coordinates puts
          the camera there – the text is the button, named by what it
          does for a screen reader, with the hover wash every control here
          takes (--accent). Unset, it is plain text saying so. */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          aria-label={setLabel}
          title={setLabel}
          onClick={props.onSet}
        >
          <Camera aria-hidden />
        </Button>
        {props.view ? (
          <button
            type="button"
            className={cn(
              POSE_TEXT,
              'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 -mx-1 rounded-sm px-1 py-0.5 text-left outline-none focus-visible:ring-2',
            )}
            aria-label={goLabel}
            title={goLabel}
            data-testid={`path-${props.which}`}
            onClick={props.onGoTo}
          >
            {describeKeyframe(props.view)}
          </button>
        ) : (
          <div className={cn(POSE_TEXT, 'text-muted-foreground')} data-testid={`path-${props.which}`}>
            {t('path.unset')}
          </div>
        )}
      </div>
    </div>
  )
}

export function CameraPathBar(path: CameraPathBarProps) {
  const flyable = path.start !== null && path.end !== null
  const easeId = useId()
  return (
    <section
      aria-label={t('path.title')}
      data-testid="camera-path-bar"
      // The same glass as the popovers and the rail: a translucent card
      // over the map, not an opaque dialog on it
      className="bg-card/85 text-card-foreground border-border/60 pointer-events-auto flex w-xl flex-col gap-2.5 rounded-lg border p-3 shadow-lg backdrop-blur-xl"
    >
      {/* The head: the title, the info mark whose tooltip says what the
          bar needs saying – the flight is the wall clock's, and H clears
          the frame – the reset beside it (it puts the whole bar back the
          way the popover's reset puts the knobs back, so it lives where
          that one does, at the head), and the X at the end. The mark is
          not a button – nothing happens on a click – but a focusable span
          whose content is the hint (visually hidden), so the tooltip opens
          from the keyboard too and a screen reader reads the sentence
          itself rather than announcing a control that does nothing. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <span className="text-sm font-medium">{t('path.title')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-6 cursor-help items-center justify-center rounded-md outline-none focus-visible:ring-2 [&_svg]:size-3"
              >
                <Info aria-hidden />
                <span className="sr-only">{t('path.hint')}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              {t('path.hint')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-my-1 shrink-0"
                aria-label={t('path.reset')}
                disabled={path.start === null && path.end === null}
                onClick={path.onClear}
              >
                <RotateCcw aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('path.reset')}</TooltipContent>
          </Tooltip>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-my-1 -mr-1 shrink-0"
          aria-label={t('path.close')}
          title={t('path.close')}
          onClick={path.onClose}
        >
          <X aria-hidden />
        </Button>
      </div>

      {/* The row: the two keyframes and the seconds between them, each a
          small column of its own, so the row reads left to right the way
          the flight goes. The bar's width (w-xl on the section) clears the
          panel on the left and the photo popover on the right from
          1400 px up; the keyframes fill what the duration column leaves. */}
      <div className="flex items-start gap-5">
        <Keyframe
          which="start"
          view={path.start}
          onSet={() => path.onSetKeyframe('start')}
          onGoTo={() => path.onGoTo('start')}
        />
        <Keyframe
          which="end"
          view={path.end}
          onSet={() => path.onSetKeyframe('end')}
          onGoTo={() => path.onGoTo('end')}
        />
        <div className="flex w-32 shrink-0 flex-col gap-4">
          <Knob
            label="path.duration"
            value={path.durationS}
            defaultValue={DEFAULT_DURATION_S}
            format={(s) => `${s} s`}
            min={MIN_DURATION_S}
            max={180}
            step={1}
            onChange={path.onDurationChange}
          />

          {/* The pace under the seconds: both are the flight's, not a
              keyframe's */}
          <div className="flex shrink-0 items-center gap-2">
            <span id={easeId} className="text-muted-foreground text-xs select-none">
              {t('path.ease')}
            </span>
            <Switch
              aria-labelledby={easeId}
              checked={path.ease === 'smooth'}
              onCheckedChange={(smooth) => path.onEaseChange(smooth ? 'smooth' : 'linear')}
            />
          </div>
        </div>
      </div>

      {/* The timeline, with play at its head: dragging the thumb stops the
          flight and puts the camera where it points, for looking a shot
          over before it is taken; while the flight runs the thumb follows
          it. Under its two ends the position and the length, the way a
          player shows them. */}
      <div className="flex items-start gap-3">
        {/* The button says "play" or "stop", and the two words are not
            the same width: both are laid in one grid cell, the one not
            showing hidden, so the button keeps the wider one's width and
            the timeline beside it does not jump when the flight starts. */}
        <Button
          variant={path.playing ? 'secondary' : 'default'}
          size="sm"
          className="shrink-0"
          disabled={!flyable}
          aria-label={path.playing ? t('path.stop') : t('path.play')}
          onClick={path.playing ? path.onStop : path.onPlay}
        >
          <span className="grid">
            <span className={cn(PLAY_FACE, path.playing && 'invisible')}>
              <Play aria-hidden />
              {t('path.playShort')}
            </span>
            <span className={cn(PLAY_FACE, !path.playing && 'invisible')}>
              <Square aria-hidden />
              {t('path.stopShort')}
            </span>
          </span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Slider
            className="mt-2.5"
            aria-label={t('path.progress')}
            min={0}
            max={1}
            step={0.001}
            disabled={!flyable}
            value={[path.progress]}
            onValueChange={([t]) => path.onScrub(t)}
          />
          <div
            className="text-muted-foreground flex justify-between font-mono text-[10px] leading-none tabular-nums select-none"
            data-testid="path-times"
          >
            <span>{formatPathTime(path.progress * path.durationS)}</span>
            <span>{formatPathTime(path.durationS)}</span>
          </div>
        </div>
      </div>
    </section>
  )
}
