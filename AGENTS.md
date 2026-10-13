# streamgrab — agent guide

## Project scale and verification

**Profile: personal browser extension, public MIT repository.** A Chrome MV3 extension that saves direct media
files and HLS/DASH streams. Structure and behaviour are described in `README.md`.

- The requested behaviour defines completion. Keep changes inside the existing split (`core` pure, `engine` free of
  extension APIs, `background` and `offscreen` as thin hosts).
- Check a change with what covers it: `npm run typecheck`, `npm test` for `core` and `engine`, `npm run e2e` when
  detection, messaging, header rules or the popup change. `npm run fixtures` must have been run once.
- User-facing strings live in `static/_locales/{en,zh_CN}/messages.json`; add both when adding one.
- Boundaries that are deliberate: no DRM circumvention, no site-specific deobfuscation, no remote configuration,
  telemetry or licensing. Header rules stay scoped to the extension's own requests (`tabIds: [TAB_ID_NONE]`).
- Nothing copied from another extension's source may enter this repository.
