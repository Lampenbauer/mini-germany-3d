// WICHTIG: cesium-base muss vor allen Cesium-Imports geladen werden
import '@/map/cesium-base'
import 'cesium/Build/Cesium/Widgets/widgets.css'
// Bundled font: identical text rendering on all systems
import '@fontsource-variable/inter'
import '@/index.css'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { showStaticPage } from '@/lib/static-page'

console.info(`[MiniGermany3D] Build ${__BUILD_ID__}`)

// The page under the map is for whoever gets no map (lib/static-page.ts);
// from here on the app is the page – unless it fails, and then the
// boundary shows the page again.
showStaticPage(false)

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
