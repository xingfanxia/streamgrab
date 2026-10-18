# Chrome Web Store listing

Material for the developer dashboard. The package is built with `npm run package:store`
(`release/streamgrab-store-<version>.zip`); it is the store build described in the README, without the yt-dlp
bridge and without YouTube.

## Name

`streamgrab` (10 characters). The store shows the manifest's `name`, so this is what the listing will carry. It
names no third-party product.

## Short description (manifest `description`, 89 characters)

> Saves the video or audio playing on the current page: direct files, HLS and DASH streams.

Chinese (`zh_CN` locale, shown to Chinese-language users): 保存当前页面正在播放的视频或音频：直链文件、HLS 和 DASH 流。

## Full description, English

```text
streamgrab saves the video or audio that the page you are on is playing, straight to your Downloads folder.

What it saves
• Direct media files (MP4, WebM, MP3 and more): ones the page plays, ones a page's script fetches, and ones sitting in a video or audio element that has not been played yet.
• HLS streams (.m3u8): pick a quality or take the audio only. MPEG-TS and fMP4 segments, separate audio renditions and AES-128 with a published key are supported. Live streams are recorded until you stop them.
• DASH streams (.mpd): the chosen video quality and the best audio are merged into one file.
• HLS subtitles, as a .vtt file, or as a plain-text transcript you can copy.

Streams are copied into an MP4 without re-encoding, so saving is as fast as your connection and loses no quality.

How it helps
• Picture and sound that a player fetches as two files are shown as one item and merged on download.
• On feeds that preload upcoming videos, the one you are watching is shown first.
• Each item shows a frame, its length and its size, and the list can be filtered by length and sorted.
• Downloads are fetched in pieces and continued where a connection broke, and a failed download says why.

What it does not do
• No YouTube. This store version does not save anything from YouTube.
• No DRM. Media protected with Widevine, PlayReady or FairPlay is marked as protected and cannot be saved.
• No accounts, limits, ads, analytics or telemetry. streamgrab has no server and sends nothing to its developer.

Open source under the MIT licence: https://github.com/xingfanxia/streamgrab

Only save media you have the right to keep.
```

## Full description, Simplified Chinese

```text
streamgrab 把当前页面正在播放的视频或音频直接保存到你的“下载”文件夹。

能保存什么
• 直链媒体文件（MP4、WebM、MP3 等）：页面播放的、页面脚本获取的，以及尚未播放的 video / audio 元素里的文件。
• HLS 流（.m3u8）：可选清晰度，也可只要音频。支持 MPEG-TS 和 fMP4 分片、独立音轨，以及公开密钥的 AES-128 加密。直播会一直录制，直到你停止。
• DASH 流（.mpd）：所选清晰度的视频与最佳音轨合并为一个文件。
• HLS 字幕：保存为 .vtt 文件，或保存为可直接复制的纯文本文稿。

流媒体不重新编码，直接封装为 MP4，保存速度取决于网速，画质无损。

贴心之处
• 播放器把画面和声音分成两个文件获取时，列表里显示为一项，下载时自动合并。
• 在会预加载后续视频的信息流页面，优先显示你正在看的那一个。
• 每一项都显示画面截图、时长和大小，列表可按时长筛选和排序。
• 下载分段进行，连接中断后从断点继续；下载失败时会说明原因。

不做什么
• 不支持 YouTube。应用商店版不保存 YouTube 上的任何内容。
• 不破解 DRM。受 Widevine、PlayReady 或 FairPlay 保护的媒体会标明受保护，无法保存。
• 无账号、无限制、无广告、无统计、无遥测。streamgrab 没有自己的服务器，不向开发者发送任何数据。

基于 MIT 许可证开源：https://github.com/xingfanxia/streamgrab

请只保存你有权保留的内容。
```

## Category

Productivity → Tools.

## Single purpose

> streamgrab saves the audio or video that the current web page plays (direct media files and HLS or DASH streams)
> to the user's computer.

## Permission justifications

| Permission | Justification |
|---|---|
| `webRequest` | Observes the response headers of the pages' requests to recognise media files and HLS/DASH manifests, and reads the `Referer`/`Origin` of those media requests; it never blocks or changes a request. |
| `declarativeNetRequest` | Adds a temporary session rule that sets the page's `Referer`/`Origin` on the extension's own download requests only (`tabIds: [TAB_ID_NONE]`), limited to the hosts that one download contacts and removed when it ends, because many media servers refuse requests without them. |
| `scripting` | Runs a read-only function in the current tab that lists its `<video>`/`<audio>` elements (address, running time, playing state, the title shown over the picture), to find media that never appeared on the network; it changes nothing on the page. |
| `offscreen` | Opens an offscreen document that downloads and remuxes media, then hands the finished file to the downloads API as a blob URL (reason `BLOBS`), work a service worker cannot do. |
| `downloads` | Saves the finished file into the user's Downloads folder and shows it there when the user presses Show. |
| `storage` | Keeps the per-tab list of found media and the download list in session storage (cleared when the browser closes), and the popup's sort and filter choice in local storage. |
| `unlimitedStorage` | A download is assembled in the extension's private file storage before it is saved, and a long video can be several gigabytes, more than the default quota allows. |
| `webNavigation` | Clears a tab's list of found media when the tab navigates to another page, so the list never shows media from a page the user has left. |
| Host permission `<all_urls>` | Media can be served from any host, so the extension must observe requests on every site, read the media elements of whichever tab the user is on, and fetch the chosen media from the host that serves it. |

The full build on GitHub also requests `nativeMessaging` and `cookies` for its local yt-dlp bridge, and `tabs`.
The store build leaves all three out; the tab addresses and titles it reads are covered by the host permission.

## Remote code

**No, I am not using remote code.**

> All JavaScript is bundled in the package (esbuild, syntax-only minification, readable names). The extension loads
> no scripts from the network, uses no `eval` or `new Function`, and has no remote configuration. What it fetches
> from media servers (manifests, segments, files) is parsed as data, never executed. The only workers are created by
> the bundled Mediabunny library from functions that ship inside the package.

## Privacy practices tab

- **Privacy policy URL**: `https://xingfanxia.github.io/streamgrab/privacy.html` once GitHub Pages serves `/docs`
  from `main` (or link the repository file `https://github.com/xingfanxia/streamgrab/blob/main/docs/privacy.md`).
- **Data usage**: the extension handles page addresses, request headers and page titles to do its one job, entirely
  on the device; none of it is transmitted to the developer or anyone else. If the form is read as covering data that
  is handled locally, tick **Web history** and **Website content**; otherwise tick nothing. Either way, certify all
  three statements:
  - I do not sell or transfer user data to third parties, outside of the approved use cases.
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or for lending purposes.
- **Not collected**: personally identifiable information, health, financial and payment information, authentication
  information, personal communications, location, user activity (clicks, keystrokes).

## Images

| File | Size | Use |
|---|---|---|
| `screenshot-1-list.png` | 1280×800 | Screenshot: several videos on one page, with sizes, lengths and a finished download |
| `screenshot-2-quality.png` | 1280×800 | Screenshot: picking an HLS quality, audio only or subtitles |
| `promo-small.png` | 440×280 | Small promo tile |
| `../../static/icons/128.png` | 128×128 | Store icon (the extension's own icon) |

The screenshots are the store build's real popup on local test streams (colour bars), captured by
`npx tsx scripts/store/images.ts` after `npm run build:store` and `npm run fixtures`.
