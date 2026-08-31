import { useEffect, useRef, useState } from 'preact/hooks';
import type { BeamSource } from '../channels/types';
import { formatDuration } from '../core/protocol';
import { useWakeLock } from './useCamera';

interface Props {
  source: BeamSource;
  title: string;
  onStop: () => void;
}

/**
 * Fullscreen transmit surface.
 *
 * The canvas backing store is sized to real device pixels: at Turbo density a grid
 * cell is only a handful of pixels wide, and letting the browser upscale a smaller
 * buffer would blur exactly the detail the receiver needs.
 */
export function BeamStage({ source, title, onStop }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [frames, setFrames] = useState(0);

  useWakeLock(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * ratio);
      const height = Math.round(canvas.clientHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const started = performance.now();
    const interval = 1000 / source.fps;
    let nextDue = started;
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now < nextDue) return;

      // Skip rather than catch up: after a stall, replaying the missed frames
      // back-to-back would flash them by faster than any camera could sample.
      nextDue = now + interval;

      source.renderFrame(ctx, canvas.width, canvas.height);
      setFrames(source.framesSent);
      setElapsed((now - started) / 1000);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [source]);

  const passes = source.chunkCount === null ? frames / Math.max(1, source.fps * source.estimatedSeconds) : null;

  return (
    <div class="beam">
      <canvas ref={canvasRef} />
      <div class="beam-bar">
        <div class="stats">
          <div class="title">{title}</div>
          <div class="mono">
            {formatDuration(elapsed)} · {frames} Frames ·{' '}
            {passes === null
              ? `ca. ${formatDuration(source.estimatedSeconds)} pro Durchlauf`
              : `${Math.floor(passes)}. Wiederholung`}
          </div>
        </div>
        <button class="btn btn-ghost" onClick={onStop}>
          Stopp
        </button>
      </div>
    </div>
  );
}
