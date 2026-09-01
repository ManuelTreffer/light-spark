import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TransferAssembler, type AssemblerState } from '../core/assembler';
import { formatBytes, formatDuration, type ReceivedPayload } from '../core/protocol';
import { CHANNELS, type ChannelId, type ChannelReceiver } from '../channels/types';
import { QrReceiver } from '../channels/qr/receiver';
import { GridReceiver } from '../channels/grid/receiver';
// Flash Beacon is temporarily disabled — real-world reception wasn't reliable
// enough yet. Left commented out, not deleted, for future work.
// import { BeaconReceiver } from '../channels/beacon/receiver';
// import { BEACON_PALETTE } from '../channels/beacon/codec';
// `payloadFromText` was only needed to build the result the (currently disabled)
// beacon receiver hands back — see the commented-out branch below.
import { cameraErrorMessage, useCamera, useWakeLock } from './useCamera';
import { PayloadPreview } from './PayloadPreview';

export function ReceiveView() {
  const [channel, setChannel] = useState<ChannelId>('qr');
  const [state, setState] = useState<AssemblerState | null>(null);
  const [result, setResult] = useState<ReceivedPayload | null>(null);
  const [tick, setTick] = useState(0);

  const assembler = useMemo(
    () => new TransferAssembler(setState, setResult),
    // Rebuilt per channel so a half-finished scan never bleeds into the next one.
    [channel],
  );

  const receiver = useMemo<ChannelReceiver>(() => {
    if (channel === 'qr') return new QrReceiver((bytes) => assembler.ingestPacket(bytes));
    // Flash Beacon disabled, see imports above:
    // if (channel === 'beacon') {
    //   return new BeaconReceiver((text) => setResult({ ...payloadFromText(text), verified: true }));
    // }
    return new GridReceiver((bytes) => assembler.ingestPacket(bytes));
  }, [channel, assembler]);

  const scanning = result === null;
  const { videoRef, error, ready, fps, aspect } = useCamera(receiver, scanning);
  useWakeLock(scanning);

  // The receivers mutate their own counters; poll them so the status line moves.
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [scanning]);

  const reset = useCallback(() => {
    setResult(null);
    setState(null);
    assembler.reset();
  }, [assembler]);

  if (result) return <PayloadPreview payload={result} onReset={reset} />;

  // Flash Beacon disabled, see imports above:
  // const beaconColour = receiver instanceof BeaconReceiver ? BEACON_PALETTE[receiver.observedColour] : null;
  const beaconColour = null;
  const rate =
    state?.startedAt && state.recoveredCount > 0
      ? (state.recoveredCount / state.chunkCount) * state.totalBytes / ((Date.now() - state.startedAt) / 1000)
      : 0;

  return (
    <div class="stack">
      <section class="card">
        <div class="label">Welcher Kanal?</div>
        <div class="segmented">
          {/* 'beacon' temporarily removed from the choices — see comments above */}
          {(['qr', 'grid'] as ChannelId[]).map((id) => (
            <button key={id} aria-selected={channel === id} onClick={() => setChannel(id)}>
              {CHANNELS[id].icon} {CHANNELS[id].name}
            </button>
          ))}
        </div>
        <div class="hint">{CHANNELS[channel].description}</div>
      </section>

      {error ? (
        <div class="notice">{cameraErrorMessage(error)}</div>
      ) : (
        <section class="card">
          <div class="viewfinder" style={`aspect-ratio:${aspect}`}>
            <video ref={videoRef} playsInline muted autoPlay />
            {channel === 'grid' && (
              <div class="guide">
                <div class="guide-box">
                  <span class="corner tl" />
                  <span class="corner tr" />
                  <span class="corner bl" />
                  <span class="corner br" />
                </div>
              </div>
            )}
            {beaconColour && <div class="swatch" style={`background:${beaconColour}`} />}
          </div>

          <div class="status-line">
            <span class={ready ? 'dot live' : 'dot'} data-tick={tick} />
            <span style="flex:1">{ready ? receiver.status : 'Kamera startet …'}</span>
            <span class="mono hint">{fps} fps</span>
          </div>

          {channel === 'grid' && (
            <p class="hint" style="margin-top:8px">
              Richte die vier Ecken des Rasters an den gelben Winkeln aus und halte kurz still. Die Dichte erkennt
              Light Spark selbst.
            </p>
          )}
        </section>
      )}

      {state?.locked && (
        <section class="card">
          <div class="row" style="margin-bottom:10px">
            <strong style="flex:1">Übertragung läuft</strong>
            <span class="mono hint">{Math.round(state.progress * 100)} %</span>
          </div>

          <div class="meter">
            <span style={`width:${Math.round(state.progress * 100)}%`} />
          </div>

          <ProgressGrid mask={state.mask} />

          <div class="figures">
            <div class="figure">
              <div class="k">Stücke</div>
              <div class="v">
                {state.recoveredCount}/{state.chunkCount}
              </div>
            </div>
            <div class="figure">
              <div class="k">Tempo</div>
              <div class="v">{rate > 0 ? `${formatBytes(Math.round(rate))}/s` : '–'}</div>
            </div>
            <div class="figure">
              <div class="k">Rest</div>
              <div class="v">
                {rate > 0 ? formatDuration((state.totalBytes * (1 - state.progress)) / rate) : '–'}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Each square is one chunk of the file, lighting up as it arrives. */
function ProgressGrid({ mask }: { mask: boolean[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Beyond a few hundred squares the grid stops reading as progress and starts
  // looking like noise, so bucket chunks together and light a square once its
  // whole bucket has landed.
  const buckets = 240;
  const cells =
    mask.length <= buckets
      ? mask
      : Array.from({ length: buckets }, (_, i) => {
          const from = Math.floor((i * mask.length) / buckets);
          const to = Math.floor(((i + 1) * mask.length) / buckets);
          for (let k = from; k < to; k++) if (!mask[k]) return false;
          return true;
        });

  const columns = Math.min(30, Math.max(8, Math.ceil(Math.sqrt(cells.length * 1.6))));

  return (
    <div class="progress-grid" ref={ref} style={`grid-template-columns:repeat(${columns},1fr)`}>
      {cells.map((on, i) => (
        <i key={i} class={on ? 'on' : undefined} />
      ))}
    </div>
  );
}
