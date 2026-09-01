import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatBytes, type ReceivedPayload } from '../core/protocol';

/** Shows what arrived — inline where we can render it, and always as a download. */
export function PayloadPreview({ payload, onReset }: { payload: ReceivedPayload; onReset: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blob = new Blob([payload.data as BlobPart], { type: payload.mime || 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [payload]);

  const text = useMemo(() => {
    if (!payload.mime.startsWith('text/') && payload.mime !== 'application/json') return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(payload.data);
    } catch {
      return null;
    }
  }, [payload]);

  const isLink = text !== null && /^https?:\/\/\S+$/.test(text.trim());

  return (
    <section class="card">
      <div class="result-head">
        <div class={payload.verified ? 'check' : 'check bad'}>{payload.verified ? '✓' : '!'}</div>
        <div style="flex:1;min-width:0">
          <h3 style="font-size:16px">{payload.name}</h3>
          <div class="hint">
            {formatBytes(payload.data.length)} ·{' '}
            {payload.verified ? 'Prüfsumme stimmt' : 'Prüfsumme stimmt nicht – Daten unvollständig'}
          </div>
        </div>
      </div>

      {/*
        The checksum only proves the bytes weren't mangled in transit — it says nothing
        about who sent them or whether they're safe to open. Anyone with a camera pointed
        at this screen (or vice versa) can send data here, so make that limit explicit
        rather than let the green checkmark above read as a safety guarantee.
      */}
      <p class="hint" style="margin:-4px 0 10px">
        Die Prüfsumme bestätigt nur, dass die Daten unterwegs nicht beschädigt wurden – nicht, von wem sie stammen.
        Öffne unbekannte Dateien und Links mit der gleichen Vorsicht wie bei jedem anderen unbekannten Absender.
      </p>

      <div class="preview">
        {text !== null ? (
          isLink ? (
            <div>
              <p class="hint" style="margin-bottom:6px">⚠️ Link von unbekannter Quelle – vor dem Öffnen prüfen.</p>
              <a href={text.trim()} target="_blank" rel="noreferrer noopener" style="word-break:break-all">
                {text.trim()}
              </a>
            </div>
          ) : (
            <pre>{text}</pre>
          )
        ) : payload.mime.startsWith('image/') && url ? (
          <img src={url} alt={payload.name} />
        ) : payload.mime.startsWith('audio/') && url ? (
          <audio controls src={url} />
        ) : payload.mime.startsWith('video/') && url ? (
          <video controls src={url} style="max-width:100%;border-radius:6px" />
        ) : (
          <div class="hint">Keine Vorschau für {payload.mime || 'unbekannten Typ'} – lade die Datei herunter.</div>
        )}
      </div>

      <div class="row">
        {url && (
          <a class="btn" href={url} download={payload.name} style="text-decoration:none">
            Herunterladen
          </a>
        )}
        {text !== null && (
          <button class="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(text)}>
            Kopieren
          </button>
        )}
        <button class="btn btn-ghost" style="margin-left:auto" onClick={onReset}>
          Weiter empfangen
        </button>
      </div>
    </section>
  );
}
