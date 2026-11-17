import './globals.css';

import { ENGINE_V } from './versions';

export const metadata = {
  title: 'StarX — by Sm0ke',
  applicationName: 'StarX',
  description: 'StarX — a fast, encrypted web proxy by Sm0ke.',
  authors: [{ name: 'Sm0ke' }],
  icons: {
    icon: [
      { url: '/starx-logo.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/starx-logo.png', sizes: '512x512' }],
    shortcut: '/starx-logo.png',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#05060c',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Start the proxy engine downloads while the shell is still parsing.
            The engine script is consumed immediately by Loader.js. */}
        <link rel="preload" href={`/libcurl/index.js?v=${ENGINE_V}`} as="script" />
        {/* libcurl.js fetches its wasm with credentials:"same-origin" but our
            warm-up fetch cannot match that credential mode, so a preload would
            just log "preloaded but not used". prefetch warms the HTTP cache
            silently instead. */}
        <link rel="prefetch" href="/libcurl/libcurl.wasm" as="fetch" type="application/wasm" />
        <link rel="prefetch" href="/cfvi4/ses5q6.wasm" as="fetch" type="application/wasm" />
      </head>
      <body>{children}</body>
    </html>
  );
}
