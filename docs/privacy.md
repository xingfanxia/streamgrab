# streamgrab privacy policy

Effective 18 October 2026. This policy covers the streamgrab extension as published in the Chrome Web Store.

**In short: streamgrab has no server. It sends nothing about you or your browsing to its developer or to anyone
else, has no analytics or telemetry, and saves files only to your own disk.**

## What the extension looks at, and why

streamgrab exists to save the video or audio that the page you are on plays. To find that media it reads, inside
your browser:

- **The network requests pages make**: their addresses and the response headers that say what a response is (type,
  length, range). This is how media files and HLS/DASH stream manifests are recognised. For those media requests
  only, it also keeps the `Referer` and `Origin` request headers, because many media servers refuse a download that
  does not repeat them.
- **The media elements on the current tab**: when media is found or the popup is open, it reads each `<video>` and
  `<audio>` element's address, running time and whether it is playing, and the title the page shows for it. It does
  not read or change anything else on the page.
- **The tab's address and title**, to show which page the list belongs to and to name the saved file.

None of this leaves your browser. It is kept in the extension's session storage, which the browser clears when it
closes, and it is capped at the newest 40 items per tab and the last 30 finished downloads. A tab's list is forgotten
when the tab navigates to another page or is closed.

## What it stores

| Where | What | How long |
|---|---|---|
| Session storage | The media found per tab, the list of downloads, and the reason a download failed | Until the browser closes |
| Local storage | Your sort order and length filter in the popup; for servers that cut off parallel transfers, how many to run at once | Until you uninstall; the server limits expire after a week |
| The extension's private file storage | A download while it is being assembled | Deleted once the file is in your Downloads folder, or when the download ends |
| Your Downloads folder | The files you choose to save | Yours to keep |

## Network requests

streamgrab makes requests only to the servers that host the media your pages load: to read stream manifests, to
read a frame and the running time of media found on the tab in front, and to download what you choose. These requests
carry your browser's cookies for that server and the page's `Referer` and `Origin`, exactly as the page's own player
would. Header changes apply only to the extension's own requests, never to the pages you browse.

It contacts no other server. There is no account, no licence check, no remote configuration, no update channel of its
own, and no code loaded from the internet.

## Sharing

Nothing is sold, shared or transferred. Nothing is used for advertising, profiling or creditworthiness. When a
download fails, you can copy a record of its requests to your clipboard yourself; query strings, which often carry
signed tokens, are left out of it, and it goes only where you paste it.

## What it does not do

The store version does not save anything from YouTube and does not circumvent DRM.

## Changes and contact

Changes to this policy are made in the public repository, with their history:
<https://github.com/xingfanxia/streamgrab/blob/main/docs/privacy.md>. Questions go to the repository's issue
tracker: <https://github.com/xingfanxia/streamgrab/issues>.
