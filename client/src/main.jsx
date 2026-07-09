import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App.jsx';
import ConfirmProvider from './components/ConfirmProvider';
import './index.css';
import { applyInitialTheme } from './store/theme';
import { applyInitialTradeSettings } from './store/tradeSettings';

// Stamp the saved/system theme on <html> BEFORE React renders. Doing it later
// causes a brief flash of the wrong palette ("FOUC") on every page load.
applyInitialTheme();
// Apply persisted Trade Settings appearance (overrides plain theme when the
// user picked light/dark/system from the drawer).
applyInitialTradeSettings();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
      <Toaster
        position="top-right"
        /* Push toasts below the top bar so the order-filled popup never covers
           the account / balance pill on the Trade page (and the header elsewhere). */
        containerStyle={{ top: 72 }}
        toastOptions={{
          style: { background: '#FFFFFF', color: '#1F2937', border: '1px solid #E5E7EB', boxShadow: '0 6px 24px rgba(17,24,39,0.08)' },
          success: { iconTheme: { primary: '#1D4ED8', secondary: '#fff' } },
          error: { iconTheme: { primary: '#FF3B57', secondary: '#fff' } },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
