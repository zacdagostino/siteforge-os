import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PreviewFrame } from './PreviewFrame';
import './styles.css';

const isPreviewRoute = window.location.hash.startsWith('#/preview?');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isPreviewRoute ? <PreviewFrame /> : <App />}</StrictMode>,
);
