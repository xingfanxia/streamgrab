# Promo videos

Two short silent videos about streamgrab, built from code. The mechanism is shown as one object, a film splicing
bench, drawn with the [Anatomy](https://github.com/wheresryan22/anatomy) skill's isometric kit: strips of picture
film leave a magazine, a reel of sound tape runs beside them, a clamp joins both into one print, and the print winds
onto a take-up reel.

| File | Role |
|---|---|
| `model.mjs` | The numbers and the clock. One real download (212 two-second pieces, 71.2 MB picture + 10.3 MB sound = 81.5 MB, 7:05, 1080p) replayed in a 9 second cycle; `stateAt(t)` is a pure function. |
| `bench.mjs` | The figure's geometry: static parts once, moving parts from a state. Runs in Node (build) and in the page (every frame). |
| `figure.css` | The few styles the bench adds to the kit's. |
| `build.mjs` | Writes `figure.html`, `figure-light.html` (standalone, looping) and `promo.html` (the video page) to `scratch/media/promo/build/`. |
| `page.js`, `page.css` | The video's timeline and layout. `promo.html?lang=zh\|en&format=3x4\|16x9`; `window.promoSeek(t)` draws second `t` exactly. Add `&play=1` to preview, `&t=12` to look at one moment. |
| `render.ts` | Steps `promoSeek` through every frame in Playwright Chromium, screenshots each, encodes with ffmpeg. |
| `capture-popup.ts` | Takes the real popup screenshot at 2x from the built extension and the local fixtures. |
| `shots.ts` | Stills and close-ups of the standalone figure, for checking it by eye. |

## Rebuild

The Anatomy skill must be installed at `~/.agents/skills/anatomy` (or point `ANATOMY_SKILL` at it); the build imports
its kit from there. `ffmpeg` must be on the path.

```sh
npm run build && npm run fixtures      # once, for the popup screenshot
npx tsx promo/capture-popup.ts         # scratch/media/promo/popup-many-dark@2x.png
node promo/build.mjs                   # scratch/media/promo/build/*.html
npx tsx promo/render.ts zh             # scratch/media/promo/streamgrab-zh-3x4.mp4   (1080x1440)
npx tsx promo/render.ts en             # scratch/media/promo/streamgrab-en-16x9.mp4  (1920x1080)
```

Each render also writes a poster PNG next to the video and keeps its frames in `scratch/media/promo/frames-<lang>/`.
Without the 2x capture the build falls back to `scratch/media/e2e/popup-many-dark.png`.

## Checks

```sh
node ~/.agents/skills/anatomy/scripts/lines.mjs scratch/media/promo/build/figure.html        # line ends: 0
node ~/.agents/skills/anatomy/scripts/lines.mjs scratch/media/promo/build/figure-light.html
npx tsx promo/shots.ts close-up 5 240,150,260,150                                            # a 4x close-up at t = 5 s
npx tsx promo/render.ts en --stills 1.5,5,8.5,12,16,19                                       # moments of the video
```

The figure records no shapes for the kit's geometry audit; its painter's order is set by hand and checked by eye.
