import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  buildEnvelope,
  formatBytes,
  formatDuration,
  payloadFromFile,
  payloadFromText,
  type Payload,
} from '../core/protocol';
import { CHANNELS, recommendChannel, type BeamSource, type ChannelId } from '../channels/types';
import { estimate } from '../channels/estimate';
import { QrBeamSource, QR_PRESETS } from '../channels/qr/sender';
import { GridBeamSource } from '../channels/grid/sender';
// Flash Beacon is temporarily disabled (see below) — real-world reception wasn't
// reliable enough yet. Left commented out, not deleted, for future work.
// import { BeaconBeamSource, BEACON_PRESETS } from '../channels/beacon/sender';
import { GRID_PRESETS } from '../channels/grid/spec';
// import { MAX_BEACON_BYTES } from '../channels/beacon/codec';
import { BeamStage } from './BeamStage';

type Mode = 'text' | 'file';

export function SendView() {
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const [channel, setChannel] = useState<ChannelId | null>(null);
  const [presetIndex, setPresetIndex] = useState(1);
  const [beam, setBeam] = useState<BeamSource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const textPayload = useMemo(() => (text.trim() ? payloadFromText(text) : null), [text]);
  const [filePayload, setFilePayload] = useState<Payload | null>(null);

  useEffect(() => {
    if (!file) {
      setFilePayload(null);
      return;
    }
    let stale = false;
    void payloadFromFile(file).then((result) => {
      if (!stale) setFilePayload(result);
    });
    return () => {
      stale = true;
    };
  }, [file]);

  const active = mode === 'text' ? textPayload : filePayload;

  // Built as soon as the payload exists, not on pressing send: the compressed size
  // is what every time estimate depends on, and having it ready makes start instant.
  const [envelope, setEnvelope] = useState<Uint8Array | null>(null);
  useEffect(() => {
    if (!active) {
      setEnvelope(null);
      return;
    }
    let stale = false;
    void buildEnvelope(active).then((result) => {
      if (!stale) setEnvelope(result);
    });
    return () => {
      stale = true;
    };
  }, [active]);

  const size = active?.data.length ?? 0;
  const suggested = active ? recommendChannel(size) : null;
  const chosen = channel ?? suggested;
  // const beaconFits = size > 0 && size <= MAX_BEACON_BYTES && (active?.mime.startsWith('text/') ?? false);

  const plan = chosen && envelope ? estimate(chosen, presetIndex, envelope.length, size) : null;

  const start = () => {
    if (!active || !chosen || !envelope) return;
    setProblem(null);
    try {
      setBeam(
        // Flash Beacon disabled, see import above:
        // chosen === 'beacon'
        //   ? new BeaconBeamSource(active.data, BEACON_PRESETS[presetIndex])
        //   :
        chosen === 'qr'
          ? new QrBeamSource(envelope, QR_PRESETS[presetIndex])
          : new GridBeamSource(envelope, GRID_PRESETS[presetIndex]),
      );
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'Senden fehlgeschlagen.');
    }
  };

  if (beam) {
    return <BeamStage source={beam} title={active?.name ?? 'Light Spark'} onStop={() => setBeam(null)} />;
  }

  return (
    <div class="stack">
      <section class="card">
        <div class="label">Was soll rüber?</div>
        <div class="segmented">
          <button aria-selected={mode === 'text'} onClick={() => setMode('text')}>
            Text
          </button>
          <button aria-selected={mode === 'file'} onClick={() => setMode('file')}>
            Datei
          </button>
        </div>

        {mode === 'text' ? (
          <textarea
            rows={5}
            placeholder="Link, WLAN-Passwort, Notiz …"
            value={text}
            onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
          />
        ) : (
          <label
            class={dragging ? 'dropzone over' : 'dropzone'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const dropped = event.dataTransfer?.files?.[0];
              if (dropped) setFile(dropped);
            }}
          >
            <input
              type="file"
              hidden
              onChange={(event) => setFile((event.target as HTMLInputElement).files?.[0] ?? null)}
            />
            <div class="big">{file ? '📄' : '⬆️'}</div>
            <div>{file ? file.name : 'Datei hierher ziehen oder auswählen'}</div>
            <div class="hint" style="margin-top:4px">
              {file ? formatBytes(file.size) : 'Bilder, Töne, Dokumente – am besten unter 500 KB'}
            </div>
          </label>
        )}
      </section>

      {active && (
        <section class="card">
          <div class="label">Wie soll es rüber?</div>
          <div class="channels">
            {/* 'beacon' temporarily removed from the choices — see comments above */}
            {(['qr', 'grid'] as ChannelId[]).map((id) => {
              const meta = CHANNELS[id];
              // 'disabled' used to gate the beacon channel on payload size/type:
              // const disabled = id === 'beacon' && !beaconFits;
              const disabled = false;
              const time = envelope ? estimate(id, 1, envelope.length, size).seconds : null;
              return (
                <button
                  key={id}
                  class="channel"
                  aria-pressed={chosen === id}
                  disabled={disabled}
                  onClick={() => {
                    setChannel(id);
                    setPresetIndex(1);
                  }}
                >
                  <span class="icon">{meta.icon}</span>
                  <span style="flex:1;min-width:0">
                    <span class="name">
                      {meta.name}
                      {suggested === id && !disabled && <span class="badge">Empfohlen</span>}
                      {!disabled && time !== null && <span class="badge time">≈ {formatDuration(time)}</span>}
                    </span>
                    <span class="desc">{disabled ? 'Nur für kurze Texte bis 180 Zeichen.' : meta.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {active && chosen && plan && (
        <section class="card">
          <div class="label">Tempo</div>
          <div class="segmented">
            {presetsFor(chosen).map((preset, index) => (
              <button key={preset.label} aria-selected={presetIndex === index} onClick={() => setPresetIndex(index)}>
                {preset.label}
              </button>
            ))}
          </div>
          <div class="hint">{presetsFor(chosen)[presetIndex].hint}</div>

          <div class="figures">
            <div class="figure">
              <div class="k">Nutzdaten</div>
              <div class="v">{formatBytes(size)}</div>
            </div>
            <div class="figure">
              <div class="k">{plan.chunkCount === null ? 'Symbole' : 'Stücke'}</div>
              <div class="v">{plan.chunkCount ?? Math.round(plan.seconds * plan.fps)}</div>
            </div>
            <div class="figure">
              <div class="k">Dauer</div>
              <div class="v">{formatDuration(plan.seconds)}</div>
            </div>
          </div>

          {envelope && size > 0 && envelope.length < size * 0.9 && (
            <p class="hint" style="margin-top:10px">
              Komprimiert auf {formatBytes(envelope.length)} – das spart {Math.round((1 - envelope.length / size) * 100)}{' '}
              % Sendezeit.
            </p>
          )}
        </section>
      )}

      {problem && <div class="notice">{problem}</div>}

      {active && chosen && (
        <>
          <button class="btn btn-primary" disabled={!envelope} onClick={start}>
            {CHANNELS[chosen].icon} Senden starten
          </button>
          <p class="hint" style="text-align:center">
            Der Empfänger richtet seine Kamera auf diesen Bildschirm. Es wird endlos wiederholt – du kannst jederzeit
            stoppen.
          </p>
        </>
      )}
    </div>
  );
}

function presetsFor(channel: ChannelId): { label: string; hint: string }[] {
  if (channel === 'qr') return QR_PRESETS;
  // Flash Beacon disabled, see imports above — 'grid' was the remaining fallback case:
  // if (channel === 'grid') return GRID_PRESETS;
  // return BEACON_PRESETS;
  return GRID_PRESETS;
}
