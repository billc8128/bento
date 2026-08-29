import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WorkspacePanelDemo } from './demos/WorkspacePanelDemo.tsx'

const demo = new URLSearchParams(window.location.search).get("demo")
const Root = demo === "workspace-panel" ? WorkspacePanelDemo : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
