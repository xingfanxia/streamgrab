# streamgrab

A small Chrome extension that saves the video or audio playing on the current page. It has no accounts, no
limits, no telemetry and talks to no server of its own.

It handles:

- **Direct files** the browser plays (`mp4`, `webm`, `mp3`, ...), saved as they are.
- **HLS** (`.m3u8`): pick a quality, or take audio only. MPEG-TS and fMP4 segments, separate audio renditions and
  AES-128 with a published key are supported. Live streams are recorded until you stop them.
- **DASH** (`.mpd`): the chosen video representation and the best audio one are merged.
- **HLS subtitles**, saved as a `.vtt` file next to the video.

Streams are copied into an MP4 without re-encoding, so saving is as fast as the network allows and loses no quality.

## Install

```sh
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select the `dist` folder.
Play a video, click the extension icon, and press Download. Files land in your normal downloads folder.

## What it does not do

- **DRM.** Media protected with Widevine, PlayReady or FairPlay is listed with a note and cannot be saved.
- **YouTube** and other sites that hide their media behind signed or site-specific APIs. Only what can be seen as
  a file or a standard manifest on the network is detected.
- Live DASH, DASH subtitles, and choosing between several audio languages.
- Resuming after the browser is closed; a download in progress is lost.

A finished file is assembled in the extension's private storage first and then copied into the downloads folder,
so a download briefly needs about twice its size in free disk space.

## How it works

| Part | Role |
|---|---|
| `src/background` | Service worker. Watches responses with `webRequest`, classifies them, keeps the per-tab list in `chrome.storage.session`, and installs the header rules described below. |
| `src/offscreen` | Offscreen document that runs downloads and writes the result to the origin private file system. |
| `src/engine` | Fetching and remuxing, built on [Mediabunny](https://mediabunny.dev). Independent of extension APIs, so it is tested in Node. |
| `src/core` | Pure functions: response classification, HLS and DASH summaries, WebVTT merging, file naming. |
| `src/popup` | The popup. It renders the stored state and sends commands; it holds no state of its own. |

Many servers only answer when the request carries the `Referer` or `Origin` of the page that embedded the player.
The extension remembers those two headers from the page's own request and replays them with a
`declarativeNetRequest` session rule. Each rule is limited to the hosts one download actually contacts and to
requests that belong to no tab, so it never changes what the pages you browse send. Rules are removed when the
download ends.

## Development

```sh
npm run typecheck
npm run fixtures   # generates local test media with ffmpeg
npm test           # unit tests, plus the engine against the fixtures
npm run e2e        # loads the extension into Chromium and downloads every fixture through the popup
```

`npm run fixtures` and the checks that use it need `ffmpeg` and `ffprobe` on the path.

## Licence

[MIT](LICENSE). The built extension bundles [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) and
[mpd-parser](https://github.com/videojs/mpd-parser) (Apache-2.0).

streamgrab was written from scratch. It shares no code with any other downloader extension.

Only save media you have the right to keep.
