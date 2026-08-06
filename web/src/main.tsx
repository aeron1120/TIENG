import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Kiosk } from './pages/Kiosk'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Kiosk />
  </StrictMode>,
)
