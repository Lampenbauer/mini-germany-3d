import { Bus, Ship, TrainFront, TramFront } from 'lucide-react'
import type { TransitMode } from '@/data/network-types'

/**
 * Lucide glyph per transit mode – shared by the line list (group headers)
 * and the departure board, so a tram stays a tram everywhere in the UI.
 */
export const MODE_ICON: Record<TransitMode, typeof TramFront> = {
  tram: TramFront,
  train: TrainFront,
  bus: Bus,
  ferry: Ship,
}
