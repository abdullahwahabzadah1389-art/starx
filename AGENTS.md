# Project notes

freecode reads this file before every change. Add anything it should always remember about this project.

## What this is
A Next.js (App Router) port of the `studygeometry.cfd/b` "vaulted" browser proxy.
Only the proxy browser, Cloaks and Extensions remain; Forge AI, Games, Apps, account
login, shop, chat, members, leaderboard, changelog, notes and tools were removed.

## CloudMoon game streaming (solved)
CloudMoon signs in, registers `client_register`, then receives the WebRTC `offer`
as a socket frame. The offer is multi-KB, spans several TLS records, and the
vendored libcurl WASM demuxes TCP reads into WebSocket frames itself, so it
mis-frames the message: the offer arrives cut in half and the peer connection
never completes ("Unable to Join Game / Connection failed"). A plain browser
`new WebSocket` to the same coordinator host works fine (verified from inside a
proxied frame).

Fix: at the top of `connect(...)` in `public/libcurl/index.js`, if the target
host matches `/cloudmoonapp\.com|cloudmoon\.net|nenly\.cn|viewoncloud\.com|cloudbatata\.com$/`,
hand the socket to the browser's native `WebSocket` and forward
onopen/onmessage/onclose/onerror; everything else keeps the relay path. Bump
`ENGINE_V` after editing, since `/libcurl/*` is served immutable. Treat this host
list as the same list as `STARX_ADBLOCK_EXEMPT` / `STARX_DENY_EXEMPT`.

Do **not** diagnose this with `wss://ws.postman-echo.com/raw`: it caps replies at
16384 bytes on both the proxied and direct path, which looks like a proxy
truncation bug but is the echo service. CloudMoon itself is fine with >64 KB frames.

### Second failure: the launcher, not the socket (solved)
With the socket fix in place, Play still failed with the generic "Failed to
connect to game server". Two separate throws in CloudMoon's launcher both get
caught and reported as that same dialog:

1. `selectedServer` is `null`/`0` ("Select Server") → it throws.
2. `newWindowLaunch !== "false"` makes it do `window.open("about:blank")` and then
   `popup.location.href = ...`. The proxy's popup has no usable `location`, so that
   throws `TypeError: Cannot set properties of undefined (setting 'href')`.

Setting `newWindowLaunch=false` + `selectedServer=23` in the *proxied frame's*
localStorage makes Roblox launch and stream (video 1280x720, playing).

**Timing is the trap.** The seeding block in `STARX_GUARD_JS`
(`public/9byt8m-v10.js`) runs at the top of `<head>`, but the proxy installs its
per-site storage shim *after* that, so a write at document start lands in the
shell's storage — CloudMoon never sees it. (Writes from `app/Loader.js` have the
same problem: they hit the shell origin.) So the block seeds once immediately and
then again on `DOMContentLoaded`, on `load`, on every capture-phase `click`, and on
a ~16 s interval, by which point the frame's real store exists. Verified with a
`getItem` trace: the values are present at Play time and the stream connects.

Validate any edit to the injected script with `node tmp/checkguard.js` (it joins
the array and `new Function()`s it, printing `PARSE OK`). A broken join silently
disables the entire guard *and* the SRI stripping — never ship without that check.

Games shelf: `public/games/index.html` + `public/games/catalog.json`
(235 entries, covers inlined as base64). `Roblox ( Cloud Moon )` sits right after
`Roblox` and points at `https://web.cloudmoonapp.com/game/com.roblox.client/`.

### Link health (checked game by game, Nov 2026)
Every entry was fetched directly and then opened through the proxy. Two findings
that are easy to re-break:

1. **`raw.githack.com` / `rawcdn.githack.com` are unusable for the shelf.** A real
   browser page load gets an "External Content Notice" interstitial instead of the
   file (curl does not, which is why a link can look fine in a shell test). All
   GitHub-hosted entries now go through `cdn.jsdmirror.com/gh/<owner>/<repo>@<branch>/<path>`,
   which serves the raw file with no notice and no 50 MB repo cap (plain
   `cdn.jsdelivr.net` rejects these repos for size).
2. **Those CDNs serve `.html` as `text/plain` + `nosniff`,** so a game renders as
   source code. `starxFinalizeResponse` in `public/9byt8m-v10.js` therefore sniffs a
   200 response whose body starts with `<!doctype html`/`<html` and re-serves it as
   `text/html`. It sniffs the *body*, not the URL: by then the URL is the proxy
   route with the target base64-encoded. Keep that in mind before "simplifying" it.

Dead links were replaced rather than removed: GameDistribution slugs
(`https://html5.gamedistribution.com/<32-hex-id>/`) for Vex 3/7, Eggy Car, Amaze!
and Cookie Clicker; jsdmirror asset repos for the rest (Drift Hunters, Smash Karts,
Yohoho, Fireboy and Watergirl, Temple Run 2, Cluster Rush, Pool, Papa's Taco Mia,
Burrito Bison, Bloxorz, Basketball Stars, Rocket League 2D, Dino Game, Watermelon
Game, TNT Sandbox, Angry Birds). Minecraft 1.3/1.5.2 became
**Minecraft (Eaglercraft 1.5.2)** and **(EaglercraftX 1.8)**, which are real
playable Minecraft builds.

Some sites answer HTTP 403 to a plain fetch (Cloudflare "Just a moment…") but work
fine in the proxy — BasketBros and Pizza Tower both did. Test those in a browser
before calling them dead.

## Gemini (and the quirks-mode / jsUrl trap)

Gemini used to load with a correct title but an empty body and no input box. Two
independent bugs, both fixed in `public/9byt8m-v10.js`:

1. **Doctype ended up after scripts.** The HTML rewriter prepends its own
   bootstrap `<script>` tags to the document root, i.e. above `<!doctype html>`.
   A doctype that is not the first thing in the document is ignored, so the page
   loads in quirks mode (`document.compatMode === "BackCompat"`) and Gemini
   refuses to boot. `starxFixDoctype()` now hoists the doctype back to the front;
   content that preceded `<html>` is still hoisted by the parser into the start of
   `<head>`, so those scripts keep running first and in order. `starxStripSecurityAttrs`
   also de-dupes `data-starx-guard` now (it could run twice on one document).
2. **Gemini validates its own loader URL.** Its bundle reads `.src` of
   `<script id="base-js">` and throws `Error: Fa` unless that URL still matches
   `/_/js/…k=…`. Under the proxy it is a base64 route, so the check failed.
   The guard patches `document.getElementById` so that element reports the
   decoded upstream URL for `.src` (and ignores writes). It must be handed over
   *at the moment Gemini asks* — patching later is too late, and the engine also
   installs a per-element own `src` property that shadows a prototype getter.

Verify with real UI text, not just `document.title`: Gemini is working when
`document.compatMode === "CSS1Compat"` and there are 3 `textarea`/`contenteditable`
matches plus text like "Hi, I'm Gemini".

## Dependency security
Vercel refuses to deploy a known-vulnerable Next.js. Keep `next` on the newest
patched release of its line (**15.5.29** as of Nov 2026 — `15.5.4` was blocked).
`overrides` in `package.json` pin `postcss` 8.5.33 and `sharp` 0.35.5, which are
transitive deps of Next with advisories of their own; `npm audit` must report
0 vulnerabilities. Re-run `npm audit` after any dependency change.

## Custom domain
The domain must point at a host that allows service workers (`worker-src`), because
the worker is what rewrites proxied pages. The freecode static share host forbids
them, so a share link plus a custom domain still cannot proxy. Deploy the normal
(non-static) build to Vercel, then Project → Settings → Domains → add the domain and
point its DNS at Vercel (apex A record `76.76.21.21`, or a `CNAME` to
`cname.vercel-dns.com` for `www`). Vercel issues the TLS certificate automatically.
Any Node host with static hosting + no worker restrictions works the same way if it
serves the `STATIC_EXPORT=1` output.

## Static (share) build
`STATIC_EXPORT=1 npx next build` writes a plain static copy to `out/` (adds
`output: 'export'`, and skips rewrites/headers because export cannot apply them).
StarX's proxy is entirely client-side, so this copy needs no server — but the
**public static host forbids service workers** (`worker-src 'none'`), and the
worker is what rewrites pages, so proxying cannot work from that host. The shell
now detects the failed registration and says "proxy unavailable here" instead of
sitting on "connecting…" forever. Delete `out/` afterwards: it is 18 MB and the
workspace save limit is 20 MB.

## Run
`npm install && npm run dev` (preview service `freecode-preview`, port 3000).
`npm run build` must pass before deploying. No `server.js` — Vercel cannot host
persistent WebSockets, so the Wisp relay is always external.

## Cross-origin isolation (needed by some browser games)
- FivePlay (`fiveplay.lol`, mirrors `v2.` / `v3.`) redirects to
  `launcher.html` then `game.html`. Both use root-absolute paths (`/b/<hash>/...`)
  on their own host, so the proxy resolves them once the frame has the right base.
- `next.config.js` sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` on every route. Without them
  `SharedArrayBuffer` is undefined, and games whose engine runs on workers that
  share memory (FivePlay's GTA V port) stop at "not cross-origin isolated".
- `credentialless` rather than `require-corp`: ordinary cross-origin assets still
  load (fetched without cookies) instead of needing a CORP header each.
- Isolation is per browsing context and a **same-origin frame inherits it**. A
  frame from another origin does not — that is why the static publish build
  cannot run such a game.
- The shell auto-reloads **once per session** after the service worker takes
  control (`sessionStorage['starx-sw-reload']`). The engine only mounts on a
  controlled page, so a cold first visit used to sit on "connecting…" until the
  user refreshed by hand. The flag makes a broken-worker reload loop impossible.

## Ad blocking and FivePlay
- `public/9byt8m-v10.js` short-circuits known ad/telemetry hosts to a local `204`
  (`STARX_BLOCK_HOSTS` / `STARX_BLOCK_RE`), so the request never leaves the
  browser. It matches on the decoded target host, three path segments back.
- FivePlay's networks are on the list: `quge5.com`, `alwingulla.com`,
  `rtmark.net`, `html-load.cc`, `monetag.com`, `profuses.com`. They wrap the
  launcher in `tag.min.js` zone scripts and interstitials, but the site never
  checks whether they loaded, so blocking them leaves the launcher and game
  working. Verified: 3-6 ad requests answered with `204`, none reaching the
  network, launcher still renders "Launch GTA V".
- Do **not** assume that holds for every site: CloudMoon gates streaming on its
  ad network, which is why `STARX_ADBLOCK_EXEMPT` exists. Check for an ad-gate
  before adding a host to the block list.

## FivePlay's graphics requirement
- The GTA V port needs **WebGPU** (`navigator.gpu` + `requestAdapter`). Its
  `wgpu_worker.js` has no WebGL fallback, so without an adapter it stops at
  "Graphics startup failed: no WebGPU adapter" and then a thread rejection.
- This was confirmed by loading the game **directly from its own origin**, with
  no proxy involved. The VM's Chromium has no `navigator.gpu` at all (headless,
  headed under Xvfb, and every SwiftShader/Vulkan flag combination), so gameplay
  cannot be verified here — only up to data streaming.
- Needs Chrome/Edge 113+ with a real GPU (or a machine where WebGPU is enabled).
  Not a StarX defect and not fixable in the proxy.

## Hung proxy requests (the 97% stall)
- A public Wisp relay sometimes accepts a request and never answers it. Several
  of those at once strand the engine: it waits on data that will never arrive,
  so the page freezes at a partial percentage with "blocked threads" while the
  download itself has actually finished.
- `starxSwRequest` in `public/9byt8m-v10.js` now puts a 45 s deadline on each
  attempt and treats a timeout like a failed request: it rotates to the next
  relay and retries. Before this, only thrown errors were retried, so a silent
  relay hung forever.
- Measured effect on FivePlay through the proxy: data throughput went from
  ~0.4 MB/s stuck at 0% to ~1.7 MB/s reaching 24% and 68 MB in the same window.
- What is left after that is the GPU, not the proxy: this VM has no WebGPU
  adapter, so the engine stops at "Graphics startup failed: no WebGPU adapter"
  exactly as it does on the site itself with no proxy involved.

## Fullscreen control
- The button sits in the top toolbar row, aligned with the proxy's own control
  pill (cat logo / Games / Settings / Cloaks).
- That pill is React-rendered by the engine bundle inside a **closed shadow
  root**, so it cannot be queried or injected into. The shell therefore renders
  its own button (`app/Loader.js`, `.starx-fullscreen-btn`) and positions it next
  to the pill with the `--starx-fs-top/left/dx` custom properties in
  `app/globals.css`. Editing the bundle's nav array to add a real pill entry was
  attempted twice and is **not** worth it: a duplicated `children:` key silently
  breaks the 6.3 MB bundle's syntax. The bundle is pristine.
- It toggles `document.documentElement.requestFullscreen()` /
  `exitFullscreen()`, and **Alt+Shift+F** does the same. The label switches to
  "Exit" and `data-on="1"` is set while active.
- `fullscreenchange` is the source of truth (so browser- or Esc-initiated exits
  keep the label correct); state is not guessed from the click.
- Embedded contexts (a Google Sites iframe without `allowfullscreen`) reject the
  API. It cannot be escaped from inside the frame, so the control falls back to
  `html.starx-expanded`: StarX fills the frame, and a note explains that true
  browser fullscreen needs Ctrl+Cmd+F / F11. The button toggles that off too.
- A `.starx-fullscreen-fallback` copy is hidden by CSS and only exists in case the
  pill never renders.
- Under 720px the label is hidden and the button moves under the pill.

## Layout
- `app/page.js` + `app/Loader.js` — page shell. Loader registers the service worker,
  probes the Wisp relay, sets `window.__WISP_URL__`, then injects the engine scripts
  in order. `app/globals.css` holds the maintenance modal + boot splash styles.
- `public/assets/bundle-vaulted-home-apps-20261029.js` — the 6.3 MB engine bundle.
  All feature edits live here.
- `public/assets/vaulted-home-logo.css` — main stylesheet.
- `public/9byt8m-v10.js` — service worker (libcurl bridge, SRI/CSP stripping, ad blocking).
- `public/cfvi4/ses5q6.wasm` + `public/cfvi4/szst2w.js` — the **rewriter engine**.
  These were missing from the first mirror and caused every proxied page to fail
  with "rewriter wasm does not have wasm magic". Do not delete them.
- `public/6m9rd/*.js` — client-side rewriter helpers.
- `public/assets/apps-catalog.js`, `app-icons/`, `json/xander.json` — still loaded by
  the bundle but inert now; kept to avoid 404s.

## Bundle patches (search for these strings)
- Route table `UoA` / `gc`: only `home`, `cloaks`, `settings`, `extensions`, `embed`,
  `launcher`, `compat`, `achievements`, `reset`, `emu`, `profile/view`, `admin` remain.
- Top nav second group is `["settings","cloaks","extensions",...(adminVisible?["admin"]:[]),"profile"]`
  (around offset 6299300) — this is what pins Cloaks/Extensions next to Settings.
- `DV` (wisp relay list) → `[(typeof window<"u"&&window.__WISP_URL__)||"wss://wisp.mercurywork.shop/"]`.
  `fV(A)` opens `new WebSocket(A || DV[0])` with an 8s timeout.
- `piA()` → `async function piA(A){return!0}`. It used to gate the proxy behind `/api/ping`,
  which is CORS-blocked from every origin (also on the live site), so the gate is bypassed.
- `J_()` and the home form default bare domains to **https://** (not http://).
- `Je` (internal tab navigation) skips `nB(T)` when the tab is already internal, so the
  pane container is not detached. Without this, Cloaks/Extensions rendered off-screen.
- Drawer state is `[Q,C]=useState(!1)` (closed); Cloaks/Extensions are reachable from the
  top nav, so the drawer does not need a forced-open patch.

## Gotchas
- The app mounts into a **closed** shadow root on `main#_jig29al`. Inspect only via CDP
  `DOM.getDocument {pierce:true}`; `document.querySelector` cannot see inside it.
- Home URL input: `placeholder="Search the web or enter a URL"`. To drive it in tests, set
  the value with the native `HTMLInputElement.prototype.value` setter, dispatch `input`,
  then call `form.requestSubmit()`. Mouse clicks and `DOM.focus` do not work.
- Maintenance modal key `vaulted-db-maintenance-2026-11`, dismissed via `.maintenance-continue`.
- Settings live in localStorage under key `10ednm8`. The loader rewrites its `wisp` field to
  the relay that answered the probe, so a stale saved URL cannot win.
- Supabase presence/announcement calls (`hulovfywovcxwprxdnoa.supabase.co`) and
  `kristenblackburnvolleyballcamps.com/api/*` fail with CORS on every origin. Harmless.
- Proxied pages are served under `/<random>/<random>/<random>/<base64url-of-target>`.
- Some sites (YouTube, Twitch) reset HTTP/2 for the proxy's TLS fingerprint. The service
  worker now returns a readable "Proxy error" page instead of a raw 500 for those.

## Branding: StarX (by Sm0ke)
- The product is now **StarX**, credited **by Sm0ke** in the copy. Branding lives in:
  `app/layout.js` (metadata), `app/Loader.js` (boot splash + maintenance modal),
  `public/assets/bundle-*.js` (home wordmark, footer, settings, notes, legal, error
  strings), `public/assets/vaulted-{notes,tools,admin}.html`, and `public/9byt8m-v10.js`
  (notification fallback title).
- Do **not** rename these identifiers — they are wiring, not UI text:
  `vaulted://` scheme, `vaulted-*` CSS class names, `localStorage` keys (`10ednm8`,
  `cherri_*`), `window.__VAULTED_APPS__`, `cherri-shell-v10` cache name, and the
  `vaulted-*.html` / `bundle-vaulted-*.js` / `vault.svg` file names.
- The home wordmark is `children:"StarX"`. There is deliberately **no** byline
  directly under it (it was removed as a duplicate); the only "by Sm0ke" credit is
  the bottom footer `className:"home-credit"`, `children:"StarX · by Sm0ke"`.

## Internal URL scheme (important)
- Internal pages are addressed as `<scheme>://<page>` and also as a bare path
  `vaulted/settings`. The parser lives in the bundle:
  `LoA=/^(?:vaulted:\/\/|vaulted\/|starx:\/\/|starx\/|cherri:\/\/|fern:\/\/)/i`
  and `pB="vaulted/"` builds those paths.
- A naive "replace every vaulted with StarX" **breaks the proxy**: inside a regex
  literal `vaulted\/` becomes `StarX\/`, so `vaulted/settings` no longer matches,
  the nav treats it as an external URL, and every internal page falls through to
  the Brave search fallback. Never brand-replace inside `LoA`, `pB`, or
  `/^vaulted\//` — those are routing identifiers.
- Display form: the URL bar shows `starx://settings` etc. via
  `PI.url.replace(/^vaulted\//i,"starx://")`. Both `starx://` and `vaulted://`
  (and `vaulted/`, `starx/`) are accepted on input.
- Verify with `tmp/schemetest.js`: `starx://cloaks`, `starx://extensions`,
  `vaulted://settings`, `starx://home` must each render their own heading and must
  not hit `search.brave.com`.

## Tab strip visibility
- The tab strip and the `+` row used to hard-hide whenever the active page was
  home: `style:{display:PI?.isInternal&&["home","h"].includes(...)?"none":void 0}`.
  That blanked the strip the moment `+` created a home tab, so all tabs vanished
  until you navigated somewhere. Both occurrences are now gated on `H.length<=1`,
  i.e. the strip is hidden only for a single pristine home tab and always shows
  once there are 2+ tabs.
- A new tab is created in `$I` with `title:"New Tab"` and `url:"vaulted/home"`
  (`isInternal`, `internalPath:"home"`). Two later writers used to overwrite that
  title with `Home`: the route reporter `z.report` (`QI.label`) and `Je`. Both now
  keep `"New Tab"` while the tab is on home and its current title is `"New Tab"`.
- Regression test: `tmp/tabtest.js` clicks `+` three times on the home screen and
  asserts the strip stays `display:flex` with 2/3/4 tabs all labelled `New Tab`.

## Logo / favicon
- `public/starx-logo.png` (512×512, transparent) is the sunglasses-cat sticker,
  cut from the Redbubble flat artwork with a border flood-fill on near-black
  pixels, then trimmed to the largest opaque component and padded square.
- Used in three places: home wordmark (`.home-logo-mark`), the nav brand image
  (`.vaulted-nav-brand`), and the boot splash. Metadata `icons` in
  `app/layout.js` points every favicon rel at `/starx-logo.png`.
- The theme CSS used to do `filter: brightness(0) invert(1)` on the home logo for
  the *heaven* theme; that is removed because it would flatten the photo artwork
  to a white blob.

## Speed / compatibility pass (2026-11)
- `devIndicators: false` in `next.config.js` removes the dev "Issues" badge.
- Relay selection (`pickWisp` in `app/Loader.js`) races **all** candidates at
  once and keeps whichever answers the Wisp INFO packet (0x03) first, logging
  `[wisp] <url> answered in Nms`. Total budget 4s, then falls back to the first
  candidate. Never go back to sequential probing: it added up to 30s of boot.
- `app/layout.js` preloads `/libcurl/index.js` (as=script) and *prefetches* the
  two wasm blobs. Use prefetch for wasm: libcurl.js fetches it with
  `credentials:"same-origin"`, which a preload can't match, so a preload only
  produces "preloaded but not used" warnings.
- Ad/tracker blocking exists at **two** layers, both keyed on the base64url
  target segment of the proxied URL:
  1. `public/9byt8m-v10.js` — global `starxIsBlocked`/`starxBlockedResponse`,
     204 short-circuit before `_ebvd0bt.route`. Helpers MUST be on `self`: the
     fetch listener lives in a different closure than the controller loader.
  2. `public/6m9rd/ybnwpk.js` — `starxDenyHref(rawUrl)` in the Controller
     `methods.request`, because requests issued from inside the proxied page
     bypass the SW listener and would otherwise throw
     "SSL connect error" inside libcurl.
- Proxied responses have `content-security-policy`, `x-frame-options`,
  `strict-transport-security`, `permissions-policy`, `origin-agent-cluster`
  stripped in the SW.
- `window.open` in a normal (non-embed) tab previously escaped the proxy: the
  popup tap plugin (`qP`) was only installed on embed/game frames. It is now
  added to every tab frame (`createFrame(... new (Hk(),qP)(url => XG.emit(url)))`).
  The tap also handles `about:blank`/empty-URL popups by returning a stand-in
  window whose `location` writes become StarX tabs (the classic OAuth
  pre-open-then-navigate pattern).
- `SW_FILE` is `/9byt8m-v10.js`, caches `cherri-shell-v10`; v2–v9 are
  unregistered on boot (see "Service worker" below).
- **Cache busting matters more than it looks.** `/assets/*`, `/libcurl/*` and
  `/cfvi4/*` are served `immutable, max-age=31536000`, so editing one of those
  files in place does *not* reach an existing browser: the old copy is reused
  for a year. Every entry in `JS` in `app/Loader.js` carries a `?v=` tag — bump
  that tag whenever you touch an engine file, or the change will appear to have
  no effect in an already-used profile.
- **Outgoing request headers are normalized in `public/starx-bricks.js`**, which
  loads *first* in `JS`. Every proxied page runs on the proxy origin, so the
  browser stamps `Origin`/`Referer` with that origin and calls same-origin
  traffic `cross-site`; Google, Roblox and ChatGPT reject that with 401/403.
  `starxBricks.normalizeRequestHeaders` rewrites both headers to the target's
  own origin, recomputes `Sec-Fetch-Site`, and removes `Headless` from
  `User-Agent`/`Sec-Ch-Ua`. It is called from two places:
  1. `public/libcurl/index.js` — `CurlSession.fetch` is the last stop before the
     request reaches the wire, so this is the one function every proxied request
     crosses. `starxResolveProxyTarget` decodes the base64url target segment
     back out of the proxy URL first.
  2. the engine bundle's own embedded transport (`async request(A,g,I,B,e)` in
     `bundle-vaulted-*.js`), which is a *separate copy* of the libcurl client.
- **Every proxied request is retried, then failed over to another relay.**
  `CurlSession.fetch` in `public/libcurl/index.js` wraps `request_async` in
  `starxRequestWithRetry`, because the relay's egress performs the TLS handshake
  and some relays cannot negotiate TLS with certain CDNs (TikTok returns
  `Request failed with error code 35: SSL connect error`). The wrapper retries a
  connection-level failure (codes 7/16/18/28/35/52/55/56/92, "SSL connect
  error", "Could not connect to server", dropped socket) once on the same relay,
  then calls `starxFailoverRelay()`, which repoints libcurl at the next relay in
  `window.__STARX_WISPS__`, closes the sockets still bound to the old relay, and
  persists the new relay to `localStorage['10ednm8']`. 502/503/504 responses are
  retried the same way. `AbortError` is never retried.
  `app/Loader.js` sets `window.__STARX_WISPS__` right after `pickWisp()`, with
  the relay that won the probe first.
- **The service worker retries before it paints the error page.**
  `R()` in the worker awaits `starxSwRequest`, which makes up to 3 attempts and
  only then builds the "Proxy error" HTML. Previously the RPC rejected (it has
  its own timeout) while the page-side retry was still running, so the error page
  flashed and was replaced seconds later by the real document. Between attempts
  the worker posts `$starxRotateRelay` to open pages, which calls
  `window.starxRotateRelay()` in `public/libcurl/index.js` to move to the next
  relay. Requests with a `ReadableStream` body are not replayed (a stream can
  only be transferred once), so those still surface the error immediately.
- **Popup/`_blank` handling has a guard fallback.** The engine's popup plugin
  catches ordinary clicks, but a synthetic click (`el.click()`, keyboard
  activation, framework-generated anchors) can slip past it; the browser then
  opens a real window on the rewritten proxy URL, which is not a StarX route, so
  it renders blank. `STARX_GUARD_JS` in the worker now intercepts click/auxclick
  for `a[href]` with `target=_blank` and calls `window.__starxOpenProxied`
  (installed by `app/Loader.js`), which opens a real StarX tab via
  `__cherriOpenTab`.
- **Never assign one prototype's method to another.** The SRI guard wrapped
  `Element.prototype.append`, then assigned that same function to
  `Document.prototype.append` and `DocumentFragment.prototype.append`. Each has
  its own brand check, so React's hydration threw `TypeError: Illegal invocation`
  and Brave Search died. Wrap each prototype with its own original method.
- **Version tags come from `app/versions.js` (`ENGINE_V`)**, used by both
  `app/layout.js` (preload) and `app/Loader.js` (script tags). `/libcurl/*` is
  served `immutable` for a year, so the engine script itself must be requested
  with the same `?v=` as the preload or returning visitors keep a stale engine.
- **When testing headers, do not call `fetch()` on an absolute URL from inside
  the proxied frame.** The rewriter leaves the native `fetch` in place for
  absolute URLs, so the request goes straight to the target and bypasses the
  proxy entirely — the resulting headers look "wrong" but were never proxied.
  Navigate to `httpbin.org/headers` instead and read the rendered JSON.
- **SRI/nonce stripping happens in three layers**, because each sees traffic the
  others don't:
  1. SW `public/9byt8m-v10.js` — `starxStripSecurityAttrs` rewrites the HTML body
     textually (script/link `integrity`+`nonce`, CSP `<meta>`), then injects a
     guard `<script data-starx-guard>` right after `<head>`. The guard blocks the
     attributes at every DOM entry point (`setAttribute*`, prototype setters,
     `document.write`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, and
     pre-insertion sweeps in `appendChild`/`insertBefore`/`append`/`prepend`/
     `before`/`after`/`cloneNode`/`adoptNode`/`importNode`).
  2. Controller `public/6m9rd/ybnwpk.js` — `starxMaybeStripHtml` wraps the
     `fetchHandler.handleFetch` result in `methods.request`. Needed because the
     rewriter re-fetches documents through the controller and `document.write`s
     them, so the parser sees the original hash before any guard can run.
     Header-less responses are HTML-sniffed so nothing slips through.
     Never drain a `ReadableStream` body just to sniff it: the stream is
     one-shot, and a locked stream posted across the transport port throws
     `DataCloneError` and breaks streaming apps (this hit ChatGPT).
  3. The injected DOM guard (above) covers runtime-created tags.
- **Relay selection is two-tier.** `PRIORITY_WISPS` (`NEXT_PUBLIC_WISP_URL`,
  `anura.pro`, `wisp.terbiumon.top`, `wisp.mercurywork.shop`) race first with a
  2500 ms budget; `FALLBACK_WISPS` (`fern.best`, `lunaar.org`,
  `kristenblackburnvolleyballcamps.com`) only get a 3000 ms race if none of the
  fast hosts answers. Measured boot: ~1123–1215 ms, `anura.pro` answering in
  59 ms, `mercurywork` in 68 ms.
- Verified live: `https://discord.com/login` renders the real React app
  (1 email + 1 password input, submit, 2 canvas, 5 QR blocks, 359 stylesheets,
  0 `[integrity]` elements), and a `wss://gateway.discord.gg/?v=10&encoding=json`
  socket opened from inside the proxied frame returns `op=10` HELLO.

## Shareable overview page
`site/` is a standalone static landing page (no build step) published through the
publish tool. It exists because the static share host sends
`worker-src 'none'`, so the real proxy cannot run there; the page explains the
project and points at the Vercel route. Keep it in sync when user-facing facts
change (game count, which sites work). The live proxy itself deploys from the repo
root via Vercel — do not add `site/` to the Next.js build.
