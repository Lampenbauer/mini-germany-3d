// WICHTIG: cesium-base muss vor allen Cesium-Imports geladen werden
import '@/map/cesium-base'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import '@/index.css'
import { createRoot } from 'react-dom/client'
import App from '@/App'

createRoot(document.getElementById('root')!).render(<App />)
