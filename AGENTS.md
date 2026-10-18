# streamgrab — agent guide

## Project scale and verification

**Profile: personal browser extension, public MIT repository.** A Chrome MV3 extension that saves direct media
files and HLS/DASH streams, and hands other sites to a local yt-dlp. Structure and behaviour are described in `README.md`.

- The requested behaviour defines completion. Keep changes inside the existing split (`core` pure, `engine` free of
  extension APIs, `background` and `offscreen` as thin hosts).
- Check a change with what covers it: `npm run typecheck`, `npm test` for `core` and `engine`, `npm run e2e` when
  detection, messaging, header rules or the popup change. `npm run fixtures` must have been run once.
- `native/host.mjs` is plain Node with no dependencies and is started by the browser, not bundled. It must keep
  accepting only http(s) URLs and passing arguments to yt-dlp as an array, never through a shell. The extension ID
  in `native/extension-id.txt` follows from the `key` in `static/manifest.json`; change neither alone.
- The Chrome Web Store build (`npm run build:store`, `dist-store/`) shares all code; branches it must not contain
  sit behind `if (!__STORE__)`, and `scripts/build.mjs` edits its manifest and locales. It never gets the yt-dlp
  bridge or anything from YouTube (`isExcludedFromStore` in `core/sites.ts`). Check it with `npm run e2e:store`.
- User-facing strings live in `static/_locales/{en,zh_CN}/messages.json`; add both when adding one.
- Boundaries that are deliberate: no DRM circumvention, no site-specific deobfuscation, no remote configuration,
  telemetry or licensing. Header rules stay scoped to the extension's own requests (`tabIds: [TAB_ID_NONE]`).
- Nothing copied from another extension's source may enter this repository.
