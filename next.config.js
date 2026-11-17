/** @type {import('next').NextConfig} */
const IMMUTABLE = 'public, max-age=31536000, immutable';

// The public "share" build is a plain static export (STATIC_EXPORT=1). The proxy
// itself runs entirely in the browser — service worker + public Wisp relays —
// so it needs no server. Static export cannot express rewrites or headers, so
// those are left out of that build only; the normal dev/Vercel config is
// unchanged.
const STATIC = process.env.STATIC_EXPORT === '1';

const nextConfig = {
  reactStrictMode: true,
  // No red "Issues" badge over the app in dev/preview.
  devIndicators: false,
  // The proxied app is a large prebuilt bundle; no image optimisation needed.
  images: { unoptimized: true },
  // Relative asset URLs so the export works from any sub-path on the static host.
  ...(STATIC ? { output: 'export', trailingSlash: true } : {}),
  // The preview panel serves the app from a freecode.build subdomain; Next 15
  // warns when a dev request arrives from an origin it doesn't know about.
  allowedDevOrigins: ['*.freecode.build', '127.0.0.1', 'localhost'],
  async rewrites() {
    // Static export has no server to apply rewrites (Next rejects them), so the
    // share build routes only through the app's own client-side handling.
    if (STATIC) return [];
    // Internal StarX routes are rendered client-side from the shell at "/".
    // Without these, a hard refresh on starx://settings (which the URL bar
    // shows as /settings) hits the static host and 404s, most visibly on
    // Vercel where there is no dev server fallback.
    // Each destination carries ?u=starx://<page> so the shell opens that
    // tab instead of Home (the app reads its initial tab from ?u=).
    const internal = (name) => `/?u=${encodeURIComponent('starx://' + name)}`;
    return [
      { source: '/cloaks', destination: internal('cloaks') },
      { source: '/cloaks/:path*', destination: internal('cloaks') },
      { source: '/extensions', destination: internal('extensions') },
      { source: '/extensions/:path*', destination: internal('extensions') },
      { source: '/settings', destination: internal('settings') },
      { source: '/settings/:path*', destination: internal('settings') },
      { source: '/apps', destination: internal('apps') },
      { source: '/g', destination: internal('g') },
      { source: '/games', destination: internal('g') },
      // There is no login screen in this build, so /login must not 404. It
      // returns to the shell instead of leaving users on an error page.
      { source: '/login', destination: '/' },
      { source: '/chat', destination: internal('chat') },
      { source: '/music', destination: internal('music') },
      { source: '/profile', destination: internal('profile') },
      { source: '/profile/:path*', destination: internal('profile') },
      // Tabs the shell can open but which never had a URL. Without a rewrite a
      // hard refresh (or a shared link) lands on the host's 404 page.
      { source: '/members', destination: internal('members') },
      { source: '/leaderboard', destination: internal('leaderboard') },
      { source: '/changelog', destination: internal('changelog') },
      { source: '/notes', destination: internal('notes') },
      { source: '/tools', destination: internal('tools') },
      { source: '/emu', destination: internal('emu') },
      { source: '/mod', destination: internal('mod') },
      { source: '/activity', destination: internal('activity') },
      { source: '/achievements', destination: internal('achievements') },
      { source: '/compat', destination: internal('compat') },
      { source: '/l', destination: internal('launcher') },
      { source: '/embed', destination: internal('embed') },
      { source: '/shop', destination: internal('shop') },
      { source: '/admin', destination: internal('admin') },
      { source: '/assistant', destination: internal('assistant') },
    ];
  },
  async headers() {
    if (STATIC) return [];
    return [
      {
        // Service worker must be served from the origin root with a matching scope.
        source: '/9byt8m-v10.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      // Proxy engine (libcurl.js + wasm, CF worker wasm) and app assets are
      // versioned by filename, so they can be cached forever.
      {
        source: '/libcurl/:path*',
        headers: [
          { key: 'Cache-Control', value: IMMUTABLE },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
      {
        source: '/cfvi4/:path*',
        headers: [
          { key: 'Cache-Control', value: IMMUTABLE },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
      { source: '/assets/:path*', headers: [{ key: 'Cache-Control', value: IMMUTABLE }] },
      {
        source: '/cfvi4/ses5q6.wasm',
        headers: [{ key: 'Content-Type', value: 'application/wasm' }],
      },
      {
        source: '/libcurl/libcurl.wasm',
        headers: [{ key: 'Content-Type', value: 'application/wasm' }],
      },
    ];
  },
};

module.exports = nextConfig;
