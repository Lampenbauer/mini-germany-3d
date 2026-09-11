/**
 * The recordings on disk, for the dev middleware (vite.config.ts) and
 * the parity scripts: one directory per city, one file per UTC hour
 * (see archive-hours.ts for the names, ais-archive.ts and
 * aircraft-archive.ts for the lines). Node only – the app never imports
 * this, and tsconfig.app.json leaves it out for the same reason; it is
 * type-checked through vite.config.ts in the node project.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { archiveFileName, type ArchiveStore } from './archive-hours.ts'

export function archiveFilePath(dir: string, slug: string, hourKey: string): string {
  return join(dir, archiveFileName(slug, hourKey))
}

export function archiveFileStore(dir: string): ArchiveStore {
  return {
    has: (slug, hourKey) => existsSync(archiveFilePath(dir, slug, hourKey)),
    append: (slug, hourKey, text) => {
      mkdirSync(join(dir, slug), { recursive: true })
      appendFileSync(archiveFilePath(dir, slug, hourKey), text)
    },
    prune: (slug, oldestKept) => {
      const cityDir = join(dir, slug)
      if (!existsSync(cityDir)) return
      for (const name of readdirSync(cityDir)) {
        if (name.endsWith('.ndjson') && name.slice(0, -'.ndjson'.length) < oldestKept) {
          unlinkSync(join(cityDir, name))
        }
      }
    },
  }
}
