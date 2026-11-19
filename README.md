# StarX

**StarX** — an encrypted web proxy in the browser. **by Sm0ke.**

The proxy engine is prebuilt and lives in `public/`; the app is a small Next.js
App Router page that boots it.

## Run

```bash
npm install
npm run dev          # http://localhost:3000
```

Production check:

```bash
npm run build && npm start
```

## Branding

- Home wordmark, browser tab title (`app/layout.js` metadata), nav, settings,
  release notes, legal pages and error/notification text all read **StarX**.
- `by Sm0ke` sits under the home wordmark and in the footer credit.
- Left untouched on purpose so nothing breaks: CSS class names (`vaulted-*`),
  the `vaulted://` internal URL scheme, `localStorage` keys (`10ednm8`,
  `cherri_*`), `window.__VAULTED_APPS__`-style globals, and the engine file
  names. These are identifiers, not UI text.

## Deploying to Vercel

Requires Next.js **15.5.29** or newer on the 15.5 line: Vercel blocks deploys of
Next versions with known vulnerabilities (15.5.4 was rejected). `npm audit` is clean.

1. Push the repo (it lives at https://github.com/abdullahwahabzadah1389-art/starx) and import it at Vercel — framework preset **Next.js**, no build
   or output overrides needed.
2. Set the environment variable **`NEXT_PUBLIC_WISP_URL`** (Project → Settings →
   Environment Variables), e.g. `wss://anura.pro/`. See `.env.example`.
3. Deploy.

There is **no `server.js`** and no local `/wisp/` endpoint. Vercel cannot host a
persistent WebSocket, so the app always talks to an external Wisp relay.

### Custom domain

The domain must point at a host that **allows service workers** — the worker is what
rewrites proxied pages, so the freecode static share link cannot proxy even with a
domain attached. On Vercel: Project → Settings → Domains → add your domain, then at
your DNS provider point it at Vercel (apex `A` → `76.76.21.21`, or `CNAME` `www` →
`cname.vercel-dns.com`). Vercel provisions HTTPS by itself.

## Transport: libcurl by default

The default transport is **libcurl** (`@mercuryworkshop/libcurl-transport` 2.0.6,
which bundles `libcurl.js` 0.7.5). It does its own TLS inside WASM, so HTTPS
sites load even when the browser's TLS fingerprint would be blocked. Epoxy and
OpenSSL are still selectable in Settings → transport.

How it is wired:

- `app/Loader.js` probes the relay list with a real Wisp **INFO** packet (not just
  a socket open), then:
  - sets `window.__WISP_URL__` **before** the engine bundle is injected;
  - forces `transport: 'libcurl'` and the winning relay into the saved settings
    (`localStorage['10ednm8']`), so an old `epoxy` value or a dead relay can
    never win.
- Relay order: `NEXT_PUBLIC_WISP_URL` (comma-separated) first, then
  `wss://anura.pro/`, `wss://wisp.terbiumon.top/wisp/`,
  `wss://wisp.mercurywork.shop/`, `wss://fern.best/wisp/`,
  `wss://lunaar.org/wisp/`, `wss://kristenblackburnvolleyballcamps.com/socket/`.
- In the engine bundle, `DV = [window.__WISP_URL__ || 'wss://anura.pro/']`,
  `qpA` offers Libcurl / Epoxy / OpenSSL, and `ENA()` lazily loads
  `/libcurl/index.js` to build a `LibcurlClient`.
- `public/libcurl/` holds `index.js`, `index.mjs` and `libcurl.wasm` (the wasm is
  embedded in the bundle too; the file is kept for explicit loads).
- `public/starx-bricks.js` normalizes outgoing request headers (see below).
- `public/9byt8m-v10.js` is the service worker. It forwards requests through the
  transport bridge and strips hop-by-hop headers (`connection`,
  `transfer-encoding`, `te`, …) that corrupt streams. Failed proxy fetches render
  a friendly "Proxy error" page instead of a raw 500.

## Request header normalization

Every proxied page is served from the proxy origin, so the browser stamps
`Origin` and `Referer` with that origin and marks same-origin traffic as
`cross-site`. Sites with CSRF checks (Google, Roblox, ChatGPT) reject that.
`public/starx-bricks.js` loads first and rewrites both headers to the target's
real origin, recomputes `Sec-Fetch-Site`, and removes `Headless` from
`User-Agent` / `Sec-Ch-Ua`. It is invoked from `CurlSession.fetch` in
`public/libcurl/index.js` (the last stop before the wire) and from the engine
bundle's own embedded transport copy.

## Retry and relay failover

A Wisp relay performs the TLS handshake on its own egress, so a relay can fail
against a particular site even when the URL is fine — TikTok answers
`error code 35: SSL connect error` on some relays. Instead of showing the
"Proxy error" page, `CurlSession.fetch` retries the request once on the same
relay, then switches to the next relay in `window.__STARX_WISPS__` (built from
`PRIORITY_WISPS` / `FALLBACK_WISPS` after the boot-time probe) and replays it.
502/503/504 responses are treated the same way. The working relay is saved to
`localStorage['10ednm8']`.

Verified against `https://httpbin.org/headers` through the proxy: `Origin:
https://httpbin.org`, `Referer: https://httpbin.org/`, no `Headless` in
`User-Agent`.

Note: testing this by calling `fetch()` on an absolute URL from inside the
proxied frame does **not** work — absolute-URL fetches use the native `fetch`
and bypass the proxy. Navigate to the page instead.

## Retries, popups and the error page

`CurlSession.fetch` retries a failed request on the same relay and then fails
over to the next one. The service worker's `R()` wraps the same RPC in up to
three attempts before it renders the "Proxy error" page, and asks open pages to
rotate relays between attempts — so a slow recovery no longer flashes an error
page and then swaps in the real document.

Links with `target="_blank"` (and `window.open`) are turned into real StarX tabs
by the engine's popup plugin. A guard script injected into every proxied document
covers the cases that plugin misses — synthetic clicks, keyboard activation and
framework-generated anchors — by calling `window.__starxOpenProxied`.

## Service worker cache busting

`9byt8m-v10.js` uses cache name `cherri-shell-v10`. On every boot the loader first
unregisters any old worker listed in `OLD_SW_FILES` and deletes `cherri-shell*`
caches, then registers the current worker with `updateViaCache: 'none'`. To ship
another update, bump both the filename (`9byt8m-v10.js`) and the
`cherri-shell-v*` cache name, add the old file to `OLD_SW_FILES` in
`app/Loader.js`, and update `SW_FILE`.

## Performance & compatibility (v1.2.0-20261113)

- Relay race: all Wisp relays are probed in parallel and the first valid 0x03
  INFO reply wins, so boot no longer waits on a dead relay.
- Engine loading: `/libcurl/index.js` is preloaded and injected at mount;
  `libcurl.wasm` and `cfvi4/ses5q6.wasm` are prefetched. Served with
  `Cache-Control: public, max-age=31536000, immutable`.
- Ad/telemetry blocking runs in the service worker **and** in the proxy
  controller (see `AGENTS.md`), returning an empty 204 before any TLS handshake,
  which removes the old "SSL connect error" console spam on tracker domains.
- Popups (`window.open`, including `about:blank` pre-opens used by Google
  Sign-In) are re-routed into StarX tabs; proxied responses have CSP and
  X-Frame-Options stripped so embedded players and login widgets load.

## Address bar

Bare hostnames and domains default to **https://** — both in the home search form
and in the in-browser URL bar (`J_()` in the bundle). Existing `http://` URLs are
left alone.

## Fullscreen

There is a **Fullscreen** button in the top toolbar, next to the Games and
Settings icons. It makes the whole browser fill the screen. Click it again (or
press **Alt+Shift+F**, or Esc) to leave. On a phone it moves under the toolbar
and drops the label.

If StarX is embedded somewhere that forbids fullscreen (a Google Sites page is
the usual case) the browser's own fullscreen cannot be used from inside the
frame. Instead StarX fills the frame edge to edge and a short note tells you to
press Ctrl+Cmd+F or F11 for true fullscreen. The button still toggles it off.

## Games that need cross-origin isolation

Some browser games run their engine on workers that share memory, which the
browser only allows on a cross-origin-isolated page. FivePlay's GTA V port is one
of them. StarX sends the two headers that enable this, so those games start
instead of stopping at "not cross-origin isolated".

A page can only be isolated when it is loaded from StarX's own domain. The static
publish build cannot run these games.

## Notes on sites

TikTok, Gemini, Discord, Twitch, Google, GitHub, Wikipedia, YouTube, Instagram,
ChatGPT and Claude all render in the proxy. Gemini needed two fixes: a doctype
that had drifted behind the rewriter's bootstrap scripts (which put the page in
quirks mode, where Gemini refuses to start) and a loader-URL check of its own,
which the proxy's rewritten script address failed. That includes the app itself
loading with its chat box and sidebar, checked repeatedly.

CloudMoon cloud gaming (`web.cloudmoonapp.com`) also plays inside the
proxy: its signalling socket is handed to the browser's native WebSocket because the
libcurl WASM transport mis-frames the multi-KB WebRTC offer. Its launcher also needs
`newWindowLaunch=false` and a default `selectedServer`, which the injected guard seeds
inside the proxied page (it retries, because the proxy's per-site storage only exists
after the page boots). It is on the Games
shelf as **Roblox ( Cloud Moon )**. CloudMoon occasionally answers "Connection
failed" on the first attempt; retrying works. **x.com returns HTTP 403 from every public relay** — X blocks those
egress IPs, so it is an upstream block, not a code bug. Fixing it needs a relay
with non-blocked egress.

All 235 games on the shelf were checked link by link and then opened through the
proxy. About 25 had dead links and were repointed to working copies instead of
being dropped, so every card now loads: Vex 3/7, Eggy Car, Amaze! and Cookie
Clicker come from GameDistribution, and the rest (Drift Hunters, Smash Karts,
Yohoho, Fireboy and Watergirl, Temple Run 2, Cluster Rush, Pool, Papa's Taco Mia,
Burrito Bison, Bloxorz, Basketball Stars, Rocket League 2D, Dino Game, Watermelon
Game, TNT Sandbox, Angry Birds) from GitHub asset mirrors. Minecraft 1.3 and 1.5.2
are now **Minecraft (Eaglercraft 1.5.2)** and **(EaglercraftX 1.8)**, which are
fully playable in the browser. GitHub-hosted games load through
`cdn.jsdmirror.com`: `raw.githack.com` shows an "External Content Notice" page to
real browsers, and while plain jsDelivr works it refuses the larger asset repos.

## Layout

```
app/page.js          page shell
app/layout.js        StarX metadata (title, description, icon)
app/Loader.js        boots the service worker + engine scripts, relay probing
app/globals.css      maintenance modal, boot splash, fullscreen button
public/assets/       engine bundle, styles, fonts, icons, notes/tools pages
public/cfvi4/        rewriter js + wasm
public/6m9rd/        client js
public/libcurl/      libcurl transport + wasm
public/starx-bricks.js  outgoing header normalization (Origin/Referer/UA)
public/9byt8m-v10.js  service worker
```
