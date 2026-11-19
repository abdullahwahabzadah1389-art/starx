// Cache-busting tag for the proxy engine scripts.
//
// `/libcurl/*`, `/cfvi4/*` and `/assets/*` are all served with
// `Cache-Control: immutable, max-age=31536000`, and a `?v=` query string is part
// of the browser's cache key. Editing one of those files in place therefore has
// no effect on a browser that already downloaded it: it keeps the old copy for a
// year. Bump this tag whenever any of those files change.
//
// Both `app/layout.js` (preload) and `app/Loader.js` (script tags) must use it,
// otherwise the preload points at a different URL than the real request and
// Chrome logs "preloaded but not used".
export const ENGINE_V = 'v1.2.0-20261118-navfs';
