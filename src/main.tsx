import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/styles/global.css';
import { App } from '@/app/App.tsx';
import { initMediaAuth } from '@/lib/matrix/media.ts';

// Media worker first, so the first images already carry the access token (lib/matrix/media.ts).
void initMediaAuth().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
