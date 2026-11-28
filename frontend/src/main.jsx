import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './a11y.css'
import App from './App.jsx'

// Apply saved theme before first render to avoid flash
const savedTheme = localStorage.getItem('ui_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

import { ToastProvider } from './components/Toast';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
