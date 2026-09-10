import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@/lib/i18n'
import { showStaticPage } from '@/lib/static-page'

/**
 * What stands where the map would be when the app cannot start – a
 * viewer that throws for want of WebGL, most likely, since the Cesium
 * viewer is built in an effect and an effect's error lands here. The
 * static page under the map (lib/static-page.ts) comes back into view,
 * so the reader gets the city as text, and a notice above it says why
 * there is no map and offers another go. Without this the page went
 * white, and a white page says nothing.
 */
interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[MiniGermany3D] The app failed to start:', error, info.componentStack)
    showStaticPage(true)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        data-testid="app-failed"
        className="mx-auto mt-6 max-w-2xl rounded-xl border border-border bg-card px-5 py-4 text-card-foreground"
      >
        <p className="font-semibold">{t('page.failed')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('page.failedHint')}</p>
        <p className="mt-2 font-mono text-xs break-words text-muted-foreground">{this.state.error.message}</p>
        <button
          type="button"
          className="mt-3 cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          onClick={() => window.location.reload()}
        >
          {t('page.retry')}
        </button>
      </div>
    )
  }
}
