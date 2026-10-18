/**
 * Set by `scripts/build.mjs`: true in the Chrome Web Store build (`npm run build:store`), which has no yt-dlp bridge
 * and offers nothing from YouTube, false in the full build. Code behind `if (!__STORE__)` is left out of the store
 * bundle entirely.
 */
declare const __STORE__: boolean;
