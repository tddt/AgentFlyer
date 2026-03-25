import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(<App />);

// Dismiss the server-rendered splash screen once React has painted
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('af-splash');
    if (!splash) return;
    splash.classList.add('af-out');
    setTimeout(() => splash.remove(), 550);
  });
});
