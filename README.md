# streamgrab

A small Chrome extension that saves the video or audio playing on the current page. It has no accounts, no
limits, no telemetry and talks to no server of its own.

It handles:

- **Direct files** (`mp4`, `webm`, `mp3`, ...), saved as they are: ones the browser plays, ones a page's script
  fetches, and ones sitting in a `<video>` or `<audio>` element that has not been played yet.
- **HLS** (`.m3u8`): pick a quality, or take audio only. MPEG-TS and fMP4 segments, separate audio renditions and
  AES-128 with a published key are supported. Live streams are recorded until you stop them.
- **DASH** (`.mpd`): the chosen video representation and the best audio one are merged.
- **HLS subtitles**, saved as a `.vtt` file next to the video.
- **Transcripts**: any subtitle track, including YouTube's automatic captions through yt-dlp, saved as plain
  reading text (`.txt`) with timings and repeated lines removed, and copyable straight from the list. Videos
  without subtitles have no transcript; nothing is transcribed from the sound.
- **YouTube, Bilibili and the other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp) knows**, by handing the page
  to the copy of yt-dlp installed on your machine. See [the yt-dlp bridge](#the-yt-dlp-bridge).

Two things that pages do are handled for you. When a player fetches a video's picture and sound as two separate
files, they are shown as one item and merged on download. And on a feed that preloads the videos after the one you
are watching, the one that is playing is shown and the rest wait behind a toggle.

An item is named after the video itself where the page says what it is (through the Media Session API, or in the
text a player lays over the picture), and after the tab otherwise.

Each item shows a frame of the video, its length and its size (estimated for streams), so several videos on one
page can be told apart. The list can be filtered by length and sorted by length or size.

Streams are copied into an MP4 without re-encoding, so saving is as fast as the network allows and loses no quality.

## Install

```sh
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select the `dist` folder.
Play a video, click the extension icon, and press Download. Files land in your normal downloads folder.

## How downloads behave

- **Plain files are fetched in pieces**, the way a player fetches them, and a piece that breaks is continued from
  the last byte received. A file only counts as saved when every byte of its stated size has arrived.
- **Up to five downloads run at once per server.** If a server keeps cutting a transfer off while others from it
  are running, its limit is lowered a step, the cut transfer waits its turn, and the limit found is remembered
  for a week. Waiting downloads can be cancelled.
- **A failed download says why**, and offers the record of its requests to copy (status, range, bytes received
  before each break) with query strings left out, since those carry signed tokens.
- **Thumbnails and running times** are read when media is found on the tab in front, two items at a time.
- The list keeps the newest 40 items per tab and the last 30 finished downloads.

## The yt-dlp bridge

Some sites do not serve a file or a standard manifest that can be picked off the network; they need an extractor
that is kept up to date. Rather than reimplement those, streamgrab asks yt-dlp. With `yt-dlp` and `ffmpeg`
installed, run once:

```sh
npm run install-host                    # Google Chrome
npm run install-host -- --browser arc   # or brave, chromium, edge
```

This registers a small native messaging host (`native/host.mjs`) that only this extension may start. On the sites
listed in the popup's code the page is checked when the popup opens; anywhere else, use **Look for media on this
page with yt-dlp**. Downloads are saved by yt-dlp into your Downloads folder, and subtitles can be saved as `.srt`.

The extension passes the site's cookies from the current browser profile to yt-dlp, so content that needs your
login works. Be aware that some sites, YouTube among them, may restrict accounts they see used with a downloader. `npm run install-host -- --uninstall` removes the bridge.
macOS and Linux only.

## What it does not do

- **DRM.** Media protected with Widevine, PlayReady or FairPlay is listed with a note and cannot be saved.
- Sites that hide their media behind signed or site-specific APIs are not detected on the network; they work
  only through the yt-dlp bridge, and only as far as yt-dlp supports them.
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
| `native/host.mjs` | The yt-dlp bridge: a native messaging host that runs yt-dlp for one request and exits. |

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
[mpd-parser](https://github.com/videojs/mpd-parser) (Apache-2.0), and the
[Bricolage Grotesque](https://github.com/ateliertriay/bricolage) typeface (OFL-1.1).

streamgrab was written from scratch. It shares no code with any other downloader extension.

Only save media you have the right to keep.
