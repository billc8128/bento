import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WorkspacePanelDemo } from './demos/WorkspacePanelDemo.tsx'
import { I18nProvider } from './lib/i18n/index.tsx'
import { TurnActivityDemo } from './demos/TurnActivityDemo.tsx'

const demo = new URLSearchParams(window.location.search).get("demo")
const Root = demo === "workspace-panel" ? WorkspacePanelDemo : demo === "turn-activity" ? TurnActivityDemo : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
)
