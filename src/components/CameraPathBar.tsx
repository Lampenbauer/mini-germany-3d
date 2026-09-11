/**
 * A camera path in three rows: saved views, flight settings and playback.
 * The bar opens from the photo popover and sits above the map's readings,
 * where a shot is composed looking at the picture – and it fades to
 * half while the pointer is elsewhere, so the picture stays the thing
 * looked at; a hand over it, or the focus inside it, brings it back. A
 * bar just opened stands at full opacity for a few seconds first
 * (BAR_SETTLE_MS): it was asked for, and it should be read once before
 * it steps back. The app owns the path; only the duration's uncommitted
 * text and the settling live here.
 */

import { useEffect, useId, useState } from 'react'
import { Camera, Check, Clapperboard, Eye, Info, Play, Square, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CameraView } from '@/lib/camera-hash'
import {
  MAX_DURATION_S,
  MIN_DURATION_S,
  describeKeyframe,
  formatPathTime,
  type CameraPathEase,
} from '@/lib/camera-path'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface CameraPathControls {
  start: CameraView | null
  end: CameraView | null
  durationS: number
  ease: CameraPathEase
  playing: boolean
  /** How far along the way the camera stands, 0..1. */
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

/** How long a freshly opened bar stays fully opaque before it fades to half. */
export const BAR_SETTLE_MS = 4000

/** One face of the play button: its icon and its word, in the one grid cell both share. */
const PLAY_FACE = 'col-start-1 row-start-1 flex items-center justify-center gap-1.5'
/** One of the two paces – smaller than the readings' items, it is a setting, not a view. */
const PACE_ITEM = 'h-7 min-w-0 px-2 text-xs'

function Keyframe(props: {
  which: 'start' | 'end'
  view: CameraView | null
  playing: boolean
  onSet: () => void
  onGoTo: () => void
}) {
  const start = props.which === 'start'
  const labelId = useId()
  const setLabel = t(
    props.view
      ? start
        ? 'path.replaceStart'
        : 'path.replaceEnd'
      : start
        ? 'path.setStart'
        : 'path.setEnd',
  )
  const goLabel = t(start ? 'path.goStart' : 'path.goEnd')
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="border-border/60 flex min-w-0 flex-col gap-2 rounded-md border p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="flex items-center gap-2 text-xs font-medium">
          {/* bg-muted, not bg-accent: the accent is the hover wash and
              nothing else (see CLAUDE.md), and this chip is never hovered */}
          <span
            aria-hidden
            className="bg-muted text-muted-foreground text-2xs flex size-5 items-center justify-center rounded-sm font-mono"
          >
            {start ? '01' : '02'}
          </span>
          {t(start ? 'path.start' : 'path.end')}
        </span>
        <span className="text-muted-foreground flex items-center gap-1 text-2xs">
          {props.view && <Check aria-hidden className="text-brand-mid size-3" />}
          {t(props.view ? 'path.saved' : 'path.unset')}
        </span>
      </div>
      <div className="flex min-h-8 items-center" data-testid={`path-${props.which}`}>
        {props.view ? (
          <span className="text-muted-foreground font-mono text-[11px] leading-4 whitespace-pre-line tabular-nums">
            {describeKeyframe(props.view)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs leading-4">{t('path.emptyView')}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="min-w-0 flex-1 text-xs"
          aria-label={setLabel}
          title={setLabel}
          disabled={props.playing}
          onClick={props.onSet}
        >
          <Camera aria-hidden />
          {t(props.view ? 'path.replace' : 'path.capture')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          aria-label={goLabel}
          title={goLabel}
          disabled={!props.view}
          onClick={props.onGoTo}
        >
          <Eye aria-hidden />
          {t('path.preview')}
        </Button>
      </div>
    </div>
  )
}

/** Commit on blur/Enter so clearing the field never publishes an invalid path. */
function DurationInput(props: { value: number; onChange: (value: number) => void }) {
  const id = useId()
  const [draft, setDraft] = useState(String(props.value))
  const commit = (text: string) => {
    const parsed = text.trim() === '' ? NaN : Number(text)
    const next = Number.isFinite(parsed)
      ? Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, Math.round(parsed * 10) / 10))
      : props.value
    setDraft(String(next))
    if (next !== props.value) props.onChange(next)
  }
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-muted-foreground text-xs">
        {t('path.duration')}
      </label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={MIN_DURATION_S}
          max={MAX_DURATION_S}
          step={0.1}
          value={draft}
          aria-label={t('path.durationSeconds')}
          className="h-8 w-24 pr-6 font-mono text-xs tabular-nums"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.stopPropagation()
              // Blur reads the DOM value; restore it before committing.
              event.currentTarget.value = String(props.value)
              setDraft(String(props.value))
              event.currentTarget.blur()
            }
          }}
        />
        <span
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs"
        >
          s
        </span>
      </div>
    </div>
  )
}

export function CameraPathBar(path: CameraPathBarProps) {
  const flyable = path.start !== null && path.end !== null
  const titleId = useId()
  const statusId = useId()
  const easeId = useId()
  const elapsed = path.progress * path.durationS
  // Settled: the seconds after opening are over and the bar may fade
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), BAR_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [])
  const status = !path.start
    ? 'path.needStart'
    : !path.end
      ? 'path.needEnd'
      : path.playing
        ? 'path.running'
        : 'path.ready'
  return (
    <section
      aria-labelledby={titleId}
      data-testid="camera-path-bar"
      // The same glass as the popovers and the rail, faded to half once
      // settled while the pointer is elsewhere (see the head of this
      // file) – focus-within as well as hover, or a keyboard could never
      // see it. The fade out is slow, the way back under the pointer
      // quick: a control should answer a hand at once.
      className={cn(
        'bg-card/85 text-card-foreground border-border/60 pointer-events-auto flex w-xl max-w-[calc(100vw-7rem)] flex-col gap-3 rounded-lg border p-3 shadow-lg backdrop-blur-xl transition-opacity duration-700 hover:opacity-100 hover:duration-150 focus-within:opacity-100 focus-within:duration-150',
        settled && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clapperboard aria-hidden className="text-muted-foreground size-4" />
          <h2 id={titleId} className="text-sm font-medium">
            {t('path.title')}
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-6 cursor-help items-center justify-center rounded-md outline-none focus-visible:ring-2"
              >
                <Info aria-hidden className="size-3.5" />
                <span className="sr-only">{t('path.hint')}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              {t('path.hint')}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="-my-1 -mr-1 flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs"
            aria-label={t('path.clear')}
            title={t('path.clear')}
            disabled={path.start === null && path.end === null}
            onClick={path.onClear}
          >
            <Trash2 aria-hidden />
            {t('path.clearShort')}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('path.close')}
            title={t('path.close')}
            onClick={path.onClose}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>

      <p id={statusId} role="status" className="text-muted-foreground -mt-1 text-xs leading-4">
        {t(status)}
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        <Keyframe
          which="start"
          view={path.start}
          playing={path.playing}
          onSet={() => path.onSetKeyframe('start')}
          onGoTo={() => path.onGoTo('start')}
        />
        <Keyframe
          which="end"
          view={path.end}
          playing={path.playing}
          onSet={() => path.onSetKeyframe('end')}
          onGoTo={() => path.onGoTo('end')}
        />
      </div>

      {/* A flight uses a snapshot of these settings. Lock editing until it stops. */}
      <fieldset
        disabled={path.playing}
        className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 disabled:opacity-50"
      >
        <legend className="sr-only">{t('path.settings')}</legend>
        {/* Keyed by the value: a duration set from outside (a link, the
            reset) starts the field's draft afresh */}
        <DurationInput key={path.durationS} value={path.durationS} onChange={path.onDurationChange} />
        <div className="flex items-center gap-2">
          <span id={easeId} className="text-muted-foreground text-xs">
            {t('path.motion')}
          </span>
          <SegmentedControl
            aria-labelledby={easeId}
            value={path.ease}
            disabled={path.playing}
            onValueChange={(value) => path.onEaseChange(value as CameraPathEase)}
            className="gap-0 bg-transparent p-0.5 shadow-none backdrop-blur-none"
          >
            <SegmentedControlItem value="smooth" className={PACE_ITEM}>
              {t('path.smooth')}
            </SegmentedControlItem>
            <SegmentedControlItem value="linear" className={PACE_ITEM}>
              {t('path.linear')}
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      </fieldset>

      <div className="border-border/60 flex items-center gap-3 border-t pt-3">
        {/* Both faces occupy one cell so play/stop never shifts the timeline. */}
        <Button
          variant={path.playing ? 'secondary' : 'default'}
          size="sm"
          disabled={!flyable}
          aria-label={path.playing ? t('path.stop') : t('path.play')}
          aria-describedby={statusId}
          onClick={path.playing ? path.onStop : path.onPlay}
        >
          <span className="grid">
            <span aria-hidden={path.playing} className={cn(PLAY_FACE, path.playing && 'invisible')}>
              <Play aria-hidden />
              {t('path.playShort')}
            </span>
            <span aria-hidden={!path.playing} className={cn(PLAY_FACE, !path.playing && 'invisible')}>
              <Square aria-hidden />
              {t('path.stopShort')}
            </span>
          </span>
        </Button>
        <Slider
          className="min-w-0 flex-1 py-2.5"
          aria-label={t('path.progress')}
          aria-valuetext={t('path.progressValue', {
            seconds: Number(elapsed.toFixed(1)),
            total: path.durationS,
          })}
          min={0}
          max={path.durationS}
          step={0.1}
          disabled={!flyable}
          value={[elapsed]}
          onValueChange={([seconds]) => path.onScrub(seconds / path.durationS)}
        />
        <div
          className="text-muted-foreground shrink-0 font-mono text-xs whitespace-nowrap tabular-nums"
          data-testid="path-times"
        >
          {/* As wide as the length it counts up to, so the readout does
              not creep as the minutes turn – a width only known at
              runtime, hence a style rather than a class */}
          <span
            className="text-foreground inline-block text-right"
            style={{ minWidth: `${formatPathTime(path.durationS).length}ch` }}
          >
            {formatPathTime(elapsed)}
          </span>
          <span aria-hidden className="px-1">/</span>
          <span>{formatPathTime(path.durationS)}</span>
        </div>
      </div>
    </section>
  )
}
