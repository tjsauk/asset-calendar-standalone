import React from 'react';
import ReactDOM from 'react-dom/client';
import { AssetCalendar } from '../calendar';
import type { CalendarInput, CalendarOutput } from '../calendar';
import '../calendar/assetCalendar.css';

declare global {
  interface Window {
    assetCalendarInput?: CalendarInput;
    assetCalendarOnConfirm?: (output: CalendarOutput) => void;
  }
}

const rootEl = document.getElementById('asset-calendar-root');

if (rootEl && window.assetCalendarInput) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <AssetCalendar
        input={window.assetCalendarInput}
        onConfirm={(output) => {
          if (typeof window.assetCalendarOnConfirm === 'function') {
            window.assetCalendarOnConfirm(output);
            return;
          }
          console.log('Asset calendar output:', output);
        }}
      />
    </React.StrictMode>,
  );
}
