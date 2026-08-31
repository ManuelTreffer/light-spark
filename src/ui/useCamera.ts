import { useEffect, useRef, useState } from 'preact/hooks';
import type { CameraFrame, ChannelReceiver } from '../channels/types';

export type CameraError = 'denied' | 'missing' | 'insecure' | 'unknown';

export function cameraErrorMessage(error: CameraError): string {
  switch (error) {
    case 'denied':
      return 'Kamerazugriff wurde abgelehnt. Erlaube den Zugriff in den Browser-Einstellungen und lade die Seite neu.';
    case 'missing':
      return 'Keine Kamera gefunden.';
    case 'insecure':
      return 'Die Kamera funktioniert nur über HTTPS oder auf localhost. Starte den Dev-Server mit "npm run dev:host -- --https".';
    case 'unknown':
      return 'Die Kamera konnte nicht gestartet werden.';
  }
}

/**
 * Runs the camera and pumps frames into the active channel receiver.
 *
 * Each tick draws the video into an offscreen canvas at the receiver's preferred
 * working width and hands over one prepared `CameraFrame`, so the receivers never
 * touch getUserMedia or scaling themselves. Ticks are serialised — the native
 * barcode detector is async, and overlapping calls only build a backlog.
 */
export function useCamera(receiver: ChannelReceiver | null, active: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<CameraError | null>(null);
  const [ready, setReady] = useState(false);
  const [fps, setFps] = useState(0);
  /**
   * The viewfinder is sized to this so that `object-fit: cover` crops nothing. Only
   * then does the CSS guide box land on the same pixels as `guideBoxFor`, which is
   * what the user is being asked to aim at.
   */
  const [aspect, setAspect] = useState(4 / 3);

  // Kept in a ref so swapping channels doesn't tear down the camera stream.
  const receiverRef = useRef(receiver);
  receiverRef.current = receiver;

  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }

    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    let busy = false;
    let frames = 0;
    let lastReport = performance.now();

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext ? 'missing' : 'insecure');
        return;
      }
      // Every constraint is `ideal`, never a hard minimum: a hard one makes
      // getUserMedia fail outright on any camera that cannot meet it, and the
      // channels degrade gracefully at lower resolution or frame rate anyway.
      const preferred: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      };

      try {
        stream = await navigator.mediaDevices.getUserMedia(preferred);
      } catch (cause) {
        const name = (cause as DOMException)?.name;
        if (name === 'NotAllowedError' || name === 'NotFoundError') {
          setError(name === 'NotAllowedError' ? 'denied' : 'missing');
          return;
        }
        // Some devices reject even soft constraints; a plain request usually works.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (fallbackCause) {
          const fallbackName = (fallbackCause as DOMException)?.name;
          setError(fallbackName === 'NotAllowedError' ? 'denied' : fallbackName === 'NotFoundError' ? 'missing' : 'unknown');
          return;
        }
      }
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setReady(true);
      setError(null);
      raf = requestAnimationFrame(tick);
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const video = videoRef.current;
      const current = receiverRef.current;
      if (busy || !video || !current || video.readyState < 2 || video.videoWidth === 0) return;

      setAspect(video.videoWidth / video.videoHeight);

      const width = Math.min(current.preferredWidth, video.videoWidth);
      const height = Math.round((video.videoHeight / video.videoWidth) * width);

      let canvas = workRef.current;
      if (!canvas) canvas = workRef.current = document.createElement('canvas');
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);

      const frame: CameraFrame = { imageData: ctx.getImageData(0, 0, width, height), width, height, canvas };

      frames++;
      const now = performance.now();
      if (now - lastReport > 1000) {
        setFps(Math.round((frames * 1000) / (now - lastReport)));
        frames = 0;
        lastReport = now;
      }

      busy = true;
      void Promise.resolve(current.ingest(frame)).finally(() => {
        busy = false;
      });
    };

    void start();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      setReady(false);
    };
  }, [active]);

  return { videoRef, error, ready, fps, aspect };
}

/** Keeps the screen awake — a long beam or scan otherwise dims out halfway through. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        /* not critical */
      }
    };

    // Switching tabs drops the lock; take it again on return.
    const onVisible = () => {
      if (!released && document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
