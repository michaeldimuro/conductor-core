import './lib/theme.js';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/views.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
