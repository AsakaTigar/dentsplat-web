import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

// No StrictMode on purpose: its double-invoked effects would create and dispose two WebGL
// contexts per hot reload, which makes the FPS/PSNR readouts unusable while tuning.
createRoot(document.getElementById('root')!).render(<App />);

requestAnimationFrame(() => {
  requestAnimationFrame(() => document.getElementById('boot')?.remove());
});
