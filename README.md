# ⚡ Light Spark

**Files transferred — using only light.** One screen lights up, one camera watches.

No server, no Wi-Fi, no Bluetooth, no pairing, no account. Two devices that can *see* each other exchange data. Available as an installable PWA that runs offline.

---

## The Three Channels

| Channel             | How                                     | Speed      | Best for                                                           |
| ------------------- | --------------------------------------- | ---------- | ------------------------------------------------------------------ |
| 💡 **Flash Beacon** | The entire screen flashes in colors     | ~2 B/s     | Link, Wi-Fi password, short note — across the room, without aiming |
| 📱 **QR Stream**    | Animated QR codes, ~10/s                | ~2–5 KB/s  | The robust classic: text, small images                             |
| 🌈 **Spark Grid**   | Full-screen color grid, 3 bits per cell | ~5–15 KB/s | Larger files — requires good alignment                             |

Light Spark suggests a channel based on the amount of data; you can override the suggestion at any time.

## What Holds It All Together

**Fountain Codes (Luby Transform).** The sender does not transmit a beginning and an end, but an endless stream of “droplets”: each frame is an XOR combination of randomly selected data chunks. Enough arbitrary droplets are sufficient to reconstruct the data.

That is why **there is no return channel**. The receiver can start too late, look away, or lose frames to reflections — nobody needs to request anything. The first frames are sent *systematically* (the chunks unchanged), so a receiver that is already ready gets practically zero overhead.

**Checksums on two levels.** Every Spark Grid frame carries a CRC-32, and the completed file gets another checksum over the original content. The frame-level check is crucial: an incorrectly read droplet that goes undetected would irreparably corrupt the entire reconstruction — whereas a *detected* bad frame costs nothing; the next one arrives 100 ms later.

### A Few Details That Make the Difference

* **Base45 instead of Base64** for the QR channel. Every character fits into the alphanumeric QR mode (5.5 bits/character instead of 8) — roughly one-third more payload per code.

* **Differential color coding** for the Beacon: what is transmitted is not the color itself, but the *step* from the previous color. The step is never 0, so adjacent symbols always differ — the receiver only needs to detect changes and does not need clock recovery. Step 5 is a frame delimiter that payload data cannot fake.

* **Calibration rows in the Spark Grid**: every frame includes all palette colors in a known order. The receiver measures how the colors look through *this* camera under *this* lighting, instead of assuming nominal values that the white balance would shift anyway.

* **Four corner markers + homography**: this also makes a grid filmed at an angle readable. Markers are searched for using the *smallest* color channel — only white has all three channels high, while yellow and cyan are equally bright and would otherwise also become candidates.

* **The receiver detects the grid density itself**: it tries the presets until a checksum matches, then locks onto that configuration. Nothing needs to be manually synchronized.

## Getting Started

```bash
npm install

npm run dev
```

For **two devices**, the camera requires a secure context (HTTPS or localhost):

```bash
npm run dev:host -- --https
```

Then open the displayed network address on the phone and accept the certificate once. The network is used only to *load* the app — the transfer itself then takes place exclusively through the screen and camera.

```bash
npm test          # 56 tests

npm run build     # Production build including Service Worker
```

## Tests

Both risky channels run as complete loopback tests — without a browser or camera:

* **QR**: real QR symbols are rendered and decoded again with jsQR, including Fountain reassembly — even with 50% of frames lost.

* **Spark Grid**: a rendered grid passes through a simulated camera (perspective, blur, sensor noise, exposure, white balance) and back again. A dedicated test verifies the core guarantee: no frame may pass the checksum while still containing incorrect bytes.

## Limitations, Honestly

* Realistically suitable for **text and files up to a few hundred KB**. A 5 MB photo works technically, but takes minutes.

* Spark Grid requires a steady hand and a reasonably glare-free screen. If there are problems, use the “Safe” preset (4 colors, larger cells).

* iOS Safari does not have `BarcodeDetector`; there, jsQR is used as a fallback and is somewhat slower.

* The Beacon only transmits text up to 255 bytes — anything more would be unreasonable at that speed.

* **Flash Beacon is currently disabled in the app** — real-world reception through a camera wasn't reliable enough yet. The code (`src/channels/beacon/`) is still there and the wiring into the UI is commented out (not deleted) in `src/ui/SendView.tsx`, `src/ui/ReceiveView.tsx`, and `src/channels/types.ts`, so it can be picked back up later.

## Structure

```text
src/

  core/        Protocol: Fountain Codes, packet format, envelope, CRC, Base45

  channels/

    qr/        QR Stream            (sender, receiver, loopback test)

    grid/      Spark Grid           (spec, codec, render, detect, homography)

    beacon/    Flash Beacon         (codec, sender, receiver)

  ui/          Preact interface
```

The channels only deliver packets; Fountain reassembly and envelope verification happen centrally, once, in `core/assembler.ts`.

## Deploying to Cloudflare Pages

Light Spark is a static build (Vite + Preact, plus a service worker for the PWA) — no server or backend, so it's a good fit for Cloudflare Pages.

**Via the Cloudflare dashboard (recommended):**

1. Push this repo to GitHub (already done if you're reading this from there).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
3. Build settings:
   - Framework preset: `Vite`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Node version: picked up automatically from `.node-version` in this repo (Node 22); no extra env vars needed, since everything runs client-side.
4. Deploy. Every push to the connected branch gets its own build; pushes to the production branch go live on the `*.pages.dev` domain (or a custom domain you attach under **Custom domains**).

Camera access (`getUserMedia`) requires a secure context — Cloudflare Pages serves everything over HTTPS by default, so that just works.

**Via the CLI**, using the `wrangler.toml` already in this repo:

```bash
npm run build
npx wrangler pages deploy dist --project-name=light-spark
```

The first run asks you to log in to Cloudflare and creates the Pages project if it doesn't exist yet.

No `_redirects` file is needed — the app has no client-side routing, just one `index.html`.

## License

GPL-3.0-or-later
