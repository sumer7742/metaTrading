import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App.jsx';
import ConfirmProvider from './components/ConfirmProvider.jsx';
import './index.css';

// Apply the saved theme BEFORE first paint so there's no dark→light flash.
// Default = dark (the admin's original look).
document.documentElement.setAttribute('data-theme', localStorage.getItem('admin_theme') || 'dark');

// Match React Router's basename to Vite's build-time base so all client-
// side links/redirects work when the SPA is mounted at /admin/* under the
// combined container. Strip trailing slash — react-router expects bare path.
const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '/';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
      <Toaster
        position="top-right"
        toastOptions={{
          style: { background: '#1a2129', color: '#fff', border: '1px solid #2a323d' },
          success: { iconTheme: { primary: '#10b981', secondary: '#fff' } },
          error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
