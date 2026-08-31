import { useState } from 'preact/hooks';
import { SendView } from './ui/SendView';
import { ReceiveView } from './ui/ReceiveView';

export function App() {
  const [tab, setTab] = useState<'send' | 'receive'>('send');

  return (
    <div class="app">
      <header class="masthead">
        <div class="mark">⚡</div>
        <div>
          <h1>Light Spark</h1>
          <div class="sub">Dateien übertragen — nur mit Licht</div>
        </div>
      </header>

      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'send'} onClick={() => setTab('send')}>
          Senden
        </button>
        <button role="tab" aria-selected={tab === 'receive'} onClick={() => setTab('receive')}>
          Empfangen
        </button>
      </div>

      {tab === 'send' ? <SendView /> : <ReceiveView />}

      <p class="footnote">
        Kein Server, kein WLAN, kein Bluetooth, kein Pairing.
        <br />
        Ein Bildschirm leuchtet, eine Kamera schaut zu.
      </p>
    </div>
  );
}
