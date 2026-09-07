// WICHTIG: cesium-base muss vor allen Cesium-Imports geladen werden
import '@/map/cesium-base'
import 'cesium/Build/Cesium/Widgets/widgets.css'
// Bundled font: identical text rendering on all systems
import '@fontsource-variable/inter'
// Headings of the About dialog; the weight axis only (see --font-display)
import '@fontsource-variable/fraunces'
import '@/index.css'
import { createRoot } from 'react-dom/client'
import App from '@/App'

console.info(`[MiniGermany3D] Build ${__BUILD_ID__}`)

createRoot(document.getElementById('root')!).render(<App />)
