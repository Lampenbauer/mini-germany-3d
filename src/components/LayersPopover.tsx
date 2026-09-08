/**
 * The layers button, above the camera block: what is drawn on the map.
 *
 * Routes, stops, the names on the vehicles and ships, and the city's live
 * webcams. It used to be a block in the control panel, between the clock
 * and the line list – but none of that is about the timetable, and the
 * panel is long enough without it. Here it sits with the other controls
 * that act on the picture rather than on the simulation, one row above
 * the camera's own group and one below the map's other switches.
 *
 * The state is the app's, as everywhere on this rail: the popover shows
 * what it is handed and reports every flip straight back.
 */

import { memo } from 'react'
import { Camera, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { t } from '@/lib/i18n'

/** One webcam as the layer list names it. */
export interface WebcamChoice {
  id: number
  title: string
}

export interface LayersPopoverProps {
  showRoutes: boolean
  onToggleRoutes: (visible: boolean) => void
  showStops: boolean
  onToggleStops: (visible: boolean) => void
  /** Vehicle numbers and ship names – one switch for every name on the map. */
  showLabels: boolean
  onToggleLabels: (visible: boolean) => void
  /** The city's live webcams, as last polled – empty without the layer. */
  webcams: WebcamChoice[]
  /** The Webcams switch: pictures on the map or not (the list stays). */
  showWebcams: boolean
  onToggleWebcams: (visible: boolean) => void
  /**
   * The underground view: the pictures are off the map whatever the
   * switch says, so the switch and the list go grey until the surface.
   */
  webcamsDisabled: boolean
  /** A camera in the list was clicked: the map flies to its picture. */
  onFlyToWebcam: (id: number) => void
  /** Extra classes for the trigger – the rail styles its buttons itself. */
  triggerClassName?: string
}

/**
 * The Webcams layer: a switch like the other layers', and the city's
 * cameras listed under it – a click on one flies the map to its picture.
 * Out in the open rather than folded into an accordion, as it was while
 * this lived in the control panel: there it had a whole line list under
 * it to push off the panel, here it has nothing below it and a caret
 * would only be one click between the reader and the cameras. It keeps
 * its own scroll instead, so a city with two dozen cameras cannot grow
 * the popover past the top of the window.
 *
 * Memoized: the list only changes with a poll.
 */
const WebcamsRow = memo(function WebcamsRow(props: {
  webcams: WebcamChoice[]
  showWebcams: boolean
  disabled: boolean
  onToggleWebcams: (visible: boolean) => void
  onFlyToWebcam: (id: number) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* The switches above are the map's own furniture; the cameras are
          somebody else's pictures on it, and the list makes this half of
          the popover a different thing from the rows above. */}
      <div className="h-px bg-border" role="separator" />
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-1">
          <span className="text-sm">{t('layers.webcams')}</span>
          <span className="text-xs text-muted-foreground">({props.webcams.length})</span>
        </span>
        <Switch
          aria-label={t('layers.showWebcams')}
          checked={props.showWebcams}
          disabled={props.disabled}
          onCheckedChange={props.onToggleWebcams}
        />
      </div>
      <ScrollArea className="max-h-48" viewportClassName="scroll-fade-y">
        <ul className="flex flex-col">
          {props.webcams.map((webcam) => (
            <li key={webcam.id}>
              <button
                type="button"
                className="-mx-1 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50"
                aria-label={t('webcams.flyTo', { name: webcam.title })}
                title={webcam.title}
                disabled={props.disabled}
                onClick={() => props.onFlyToWebcam(webcam.id)}
              >
                <Camera className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm leading-tight">{webcam.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  )
})

export function LayersPopover(props: LayersPopoverProps) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className={props.triggerClassName}
              aria-label={t('layers.title')}
            >
              <Layers aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">{t('layers.title')}</TooltipContent>
      </Tooltip>
      {/* A city with many webcams can outgrow a short window, so that
          list keeps its own scroll (see WebcamsRow). */}
      <PopoverContent side="left" className="pointer-events-auto w-64">
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">{t('layers.title')}</div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('layers.routes')}</span>
            <Switch
              aria-label={t('layers.showRoutes')}
              checked={props.showRoutes}
              onCheckedChange={props.onToggleRoutes}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('layers.stops')}</span>
            <Switch
              aria-label={t('layers.showStops')}
              checked={props.showStops}
              onCheckedChange={props.onToggleStops}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('layers.labels')}</span>
            <Switch
              aria-label={t('layers.showLabels')}
              checked={props.showLabels}
              onCheckedChange={props.onToggleLabels}
            />
          </div>
          {props.webcams.length > 0 && (
            <WebcamsRow
              webcams={props.webcams}
              showWebcams={props.showWebcams}
              disabled={props.webcamsDisabled}
              onToggleWebcams={props.onToggleWebcams}
              onFlyToWebcam={props.onFlyToWebcam}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
