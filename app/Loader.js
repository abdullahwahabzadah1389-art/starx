'use client';

import { useEffect, useRef, useState } from 'react';

import { ENGINE_V } from './versions';

const SW_FILE = '/9byt8m-v10.js';
const OLD_SW_FILES = ['/9byt8m-v2.js', '/9byt8m-v3.js', '/9byt8m-v4.js', '/9byt8m-v5.js', '/9byt8m-v6.js', '/9byt8m-v7.js', '/9byt8m-v8.js', '/9byt8m-v9.js'];
const SETTINGS_KEY = '10ednm8';
const PREFS_KEY = 'starx-workspace-prefs';
const MAINTENANCE_KEY = 'vaulted-db-maintenance-2026-11';

// Wisp relays are tried in order. Vercel cannot host a persistent WebSocket,
// so there is no local /wisp/ endpoint — these are all public relays.
//
// PRIORITY_WISPS are the high-bandwidth hosts with the most reliable upgrades.
// They get the first (short) race; the rest of FALLBACK_WISPS only get a turn if
// none of them answers, so a slow or dead tail relay never delays a page load.
const DEFAULT_WISP = 'wss://anura.pro/';
const PRIORITY_WISPS = [
  'wss://anura.pro/',
  'wss://wisp.terbiumon.top/wisp/',
  'wss://wisp.mercurywork.shop/',
];
const FALLBACK_WISPS = [
  'wss://fern.best/wisp/',
  'wss://lunaar.org/wisp/',
  'wss://kristenblackburnvolleyballcamps.com/socket/',
];

// Relays configured with NEXT_PUBLIC_WISP_URL. These are the user's own, so
// they get to stand alone: they are never raced against the public relays.
function configuredWisps() {
  return (process.env.NEXT_PUBLIC_WISP_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function candidates() {
  const own = configuredWisps();
  // A self-hosted relay wins outright. Relying on a private server is the point
  // of setting it, and racing it against public ones would hand the connection
  // back to them whenever an empty relay answers the probe a few ms sooner.
  if (own.length) {
    return {
      priority: [...new Set(own)],
      all: [...new Set([...own, ...FALLBACK_WISPS])],
    };
  }
  const priority = [...PRIORITY_WISPS];
  const rest = FALLBACK_WISPS.filter((u) => !priority.includes(u));
  return {
    priority: [...new Set(priority)],
    all: [...new Set([...priority, ...rest])],
  };
}

// A relay is only usable if it answers a Wisp INFO packet. Opening the socket
// alone is not enough: some hosts accept the upgrade and then drop the stream.
// Each probe resolves with the round-trip time (ms) on success, or null.
function probe(url, timeout) {
  return new Promise((resolve) => {
    let socket;
    let done = false;
    const started = performance.now();
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket && socket.close();
      } catch {}
      resolve(ms);
    };
    const timer = setTimeout(() => finish(null), timeout);
    try {
      socket = new WebSocket(url);
    } catch {
      return finish(null);
    }
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      // Wisp INFO packet: type 0x01, stream id 0, JSON payload.
      const payload = new TextEncoder().encode('{"streamId":0}');
      const packet = new Uint8Array(5 + payload.length);
      packet[0] = 0x01;
      packet.set(payload, 5);
      try {
        socket.send(packet);
      } catch {
        finish(null);
      }
    };
    socket.onmessage = (event) => {
      const data = event.data;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
      // 0x03 = INFO reply. Anything else means the relay is not speaking Wisp.
      finish(bytes && bytes.length > 0 && bytes[0] === 0x03 ? performance.now() - started : null);
    };
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

// Race a group of relays and keep whichever answers the INFO packet first.
// Resolves with the winning URL, or null when nobody answered within `budget`.
// Losers are closed as soon as a winner is claimed, so a slow or dead relay
// never delays boot.
function raceWisp(urls, budget) {
  return new Promise((resolve) => {
    if (!urls.length) return resolve(null);
    let settled = false;
    const timers = [];
    const done = (url) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve(url);
    };
    timers.push(setTimeout(() => done(null), budget));
    urls.forEach((url) => {
      probe(url, budget)
        .then((ms) => {
          if (ms == null || settled) return;
          console.info(`[wisp] ${url} answered in ${Math.round(ms)}ms`);
          done(url);
        })
        .catch(() => {});
    });
  });
}

// Priority-then-fallback relay selection: the high-bandwidth hosts get a short
// race first, and the slower tail is only contacted when that race comes up
// empty. The overall boot budget stays bounded (~2.5s + ~3s worst case) and in
// the normal case the loser sockets are closed within a few hundred ms.
async function pickWisp(priorityBudget = 2500, fallbackBudget = 3000) {
  const { priority, all } = candidates();
  if (!all.length) return DEFAULT_WISP;

  // A configured relay is the user's own server, so give it a longer grace
  // period before falling back to a public one (a self-hosted worker may sit
  // behind a cold start).
  const own = configuredWisps();
  const fast = await raceWisp(priority, own.length ? 6000 : priorityBudget);
  if (fast) return fast;

  const rest = all.filter((u) => !priority.includes(u));
  const slow = await raceWisp(rest, fallbackBudget);
  if (slow) return slow;

  // Nothing answered (offline / all relays down): hand the bundle the default so
  // it can retry on its own instead of blocking boot forever.
  return all[0] || DEFAULT_WISP;
}

// Drop the previous service worker + its caches so a stale worker can never
// keep serving the old proxy build.
async function resetServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs.map((reg) => {
        const script = (reg.active || reg.waiting || reg.installing || {}).scriptURL || '';
        const stale = OLD_SW_FILES.some((f) => script.endsWith(f));
        return stale ? reg.unregister() : null;
      }),
    );
  } catch {}
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('cherri-shell')).map((k) => caches.delete(k)));
  } catch {}
}

const CSS = [['/assets/vaulted-home-logo.css?v=v1.2.0-20261108-r13']];
const JS = [
  // Must load first: the engine bundle's embedded libcurl transport calls into
  // starxBricks for header normalization on every outgoing request.
  `/starx-bricks.js?v=${ENGINE_V}`,
  `/cfvi4/szst2w-20261020.js?v=${ENGINE_V}`,
  `/6m9rd/ybnwpk.js?v=${ENGINE_V}`,
  '/assets/berri-supabase-accounts.js?v=v1.2.0-20261108-r13',
  '/assets/apps-catalog.js',
  `/assets/bundle-vaulted-home-apps-20261029.js?v=${ENGINE_V}`,
  '/assets/berri-live-presence.js',
];

function addLink(href) {
  if (document.querySelector(`link[data-vaulted-css="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.vaultedCss = href;
  document.head.appendChild(link);
}

function addScript(src) {
  return new Promise((resolve) => {
    if (document.querySelector(`script[data-vaulted-js="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.dataset.vaultedJs = src;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // keep going; the boot screen reports failures
    document.head.appendChild(s);
  });
}

// StarX pages that have a real path on the shell site. next.config.js rewrites
// /settings etc. to "/" so a hard refresh does not 404 on Vercel; this maps the
// path back onto the internal tab so the refresh lands where the user was.
const ROUTED_PAGES = [
  ['/g', 'g'],
  ['/games', 'g'],
  ['/cloaks', 'cloaks'],
  ['/extensions', 'extensions'],
  ['/settings', 'settings'],
  ['/apps', 'apps'],
  ['/chat', 'chat'],
  ['/music', 'music'],
  ['/profile', 'profile'],
  ['/members', 'members'],
  ['/leaderboard', 'leaderboard'],
  ['/changelog', 'changelog'],
  ['/notes', 'notes'],
  ['/tools', 'tools'],
  ['/emu', 'emu'],
  ['/mod', 'mod'],
  ['/activity', 'activity'],
  ['/achievements', 'achievements'],
  ['/compat', 'compat'],
  ['/l', 'launcher'],
  ['/embed', 'embed'],
  ['/shop', 'shop'],
  ['/admin', 'admin'],
  ['/assistant', 'assistant'],
];

// Injected documents ask the shell to open a link in a real StarX tab. This is
// the fallback for popups the engine's own plugin misses (synthetic clicks,
// keyboard activation, links created by a framework), which otherwise open a
// bare browser window on the rewritten proxy URL and come up blank.
function installOpenProxied() {
  if (window.__starxOpenProxied) return;
  window.__starxOpenProxied = (href) => {
    try {
      const u = new URL(String(href), window.location.href);
      if (!/^https?:$/i.test(u.protocol)) return false;
      const open = window.__cherriOpenTab;
      if (typeof open !== 'function') return false;
      open(u.href);
      return true;
    } catch {
      return false;
    }
  };
}

// CloudMoon streams play over a WebRTC peer connection whose signalling and
// media set-up do not survive the rewriting proxy: the page signs in, is given
// a server and joins the room, but the offer never completes and the stream tab
// ends with "Unable to Join Game / Connection failed". The same site works in a
// normal browser, so send these hosts to a real tab instead of the proxy. The
// list is the same one the service worker exempts from ad blocking.
const DIRECT_HOSTS = /(^|\.)(cloudmoonapp\.com|cloudmoon\.net|nenly\.cn|viewoncloud\.com|cloudbatata\.com|geometry\.today|nowgg\.fun|now\.gg)$/i;

function isDirectHost(href) {
  try {
    return DIRECT_HOSTS.test(new URL(String(href), window.location.href).hostname);
  } catch {
    return false;
  }
}

// The shell publishes its tab opener on window and swaps it on remount, so trap
// the property itself: whatever function gets assigned comes back wrapped and
// CloudMoon-style URLs leave the proxy as a genuine browser tab.
function installDirectBypass() {
  // CloudMoon stays inside the proxy: no tab bypass. The list is kept because
  // the service worker exempts the same hosts from ad blocking.
}


function openRoutedPage() {
  const path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  const hit = ROUTED_PAGES.find(([p]) => path === p || path.startsWith(p + '/'));
  if (!hit) return;
  const target = 'starx://' + hit[1];
  // The bundle exposes its tab opener once the shell has mounted.
  let tries = 0;
  const attempt = () => {
    const open = window.__cherriOpenTab;
    if (typeof open === 'function') {
      try {
        open(target);
      } catch {}
      // Keep the URL clean so a later refresh still resolves, but do not leave
      // the user staring at /settings while the tab bar says Home.
      try {
        window.history.replaceState(window.history.state, '', '/');
      } catch {}
      return;
    }
    if (tries++ < 40) setTimeout(attempt, 150);
  };
  attempt();
}

export default function Loader() {
  const [showNotice, setShowNotice] = useState(false);
  const [swBlocked, setSwBlocked] = useState(false);

  useEffect(() => {
    // Wisp relay for BareMux / Epoxy. Set NEXT_PUBLIC_WISP_URL on Vercel.
    // There is no local /wisp/ endpoint: Vercel cannot host persistent WebSockets.
    // The bundle reads this global when it defines its relay list, so it must be
    // set before the bundle script loads.
    window.__WISP_URL__ = DEFAULT_WISP;
    installDirectBypass();
    installOpenProxied();

    try {
      if (!localStorage.getItem(MAINTENANCE_KEY)) setShowNotice(true);
    } catch {
      setShowNotice(true);
    }

    CSS.forEach(([href]) => addLink(href));

    // Consume the <link rel=preload> hints from layout.js right away: append the
    // engine script now (the transport picks the global up later) and warm the
    // two wasm binaries into the HTTP cache. Without an actual matching request
    // the preloads are wasted and Chrome logs "preloaded but not used".
    (() => {
      if (document.querySelector('script[data-starx-engine]')) return;
      const s = document.createElement('script');
      // Versioned, because /libcurl/* is served immutable for a year: an
      // untagged URL would keep serving a stale engine to returning visitors.
      s.src = `/libcurl/index.js?v=${ENGINE_V}`;
      s.async = true;
      s.dataset.starxEngine = '1';
      document.head.appendChild(s);
      ['/libcurl/libcurl.wasm', '/cfvi4/ses5q6.wasm'].forEach((u) => {
        fetch(u, { cache: 'force-cache' }).catch(() => {});
      });
    })();

    let cancelled = false;
    (async () => {
      await resetServiceWorkers();
      if ('serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.register(SW_FILE, { updateViaCache: 'none' });
          // The engine only mounts once the worker is *controlling* this page.
          // A first visit (or a fresh worker) registers after the controller was
          // decided, so the page loads uncontrolled and sits on "connecting…"
          // until the user happens to refresh. Wait for the worker to take
          // control, then reload once — automatically, and only once per
          // session so a broken worker can never cause a reload loop.
          if (!navigator.serviceWorker.controller && reg) {
            await Promise.race([
              new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
            if (navigator.serviceWorker.controller) {
              let reloaded = false;
              try {
                reloaded = sessionStorage.getItem('starx-sw-reload') === '1';
              } catch {}
              if (!reloaded) {
                try {
                  sessionStorage.setItem('starx-sw-reload', '1');
                } catch {}
                window.location.reload();
                return;
              }
            }
          }
        } catch (err) {
          console.error('[sw] registration failed:', err);
          // Browsing through the proxy needs the worker: it is what rewrites
          // pages and relays their requests. Some static hosts forbid workers
          // outright (a `worker-src 'none'` policy), and the shell would then sit
          // on "connecting…" forever with nothing to explain it.
          setSwBlocked(true);
        }
      }
      // Verify the relay actually answers a Wisp INFO packet before booting,
      // and fall back to the next relay when it is down.
      const wisp = await pickWisp();
      window.__WISP_URL__ = wisp;
      // The transport reads this ordered list when it needs to fail over. The
      // working relay goes first so failover only ever moves to a relay that
      // already answered a probe during this boot.
      const { all: relayList } = candidates();
      window.__STARX_WISPS__ = [wisp, ...relayList.filter((u) => u !== wisp)];
      // Force the libcurl transport and the working relay into saved settings,
      // so an old "epoxy" value or a dead relay can never win.
      try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        saved.wisp = wisp;
        saved.transport = 'libcurl';
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
      } catch {}
      console.info('[wisp] using', wisp, '· transport libcurl');
      for (const src of JS) {
        if (cancelled) return;
        await addScript(src);
      }
      if (!cancelled) openRoutedPage();
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setShowNotice(false);
    document.documentElement.classList.remove('vaulted-show-maintenance');
    try {
      localStorage.setItem(MAINTENANCE_KEY, 'dismissed');
    } catch {}
  };

  useEffect(() => {
    if (!showNotice) return;
    const onKey = (e) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showNotice]);

  // Fullscreen toggle for the whole StarX window.
  //
  // The proxy's own browser chrome lives in a closed shadow root inside the
  // engine bundle, so a button cannot be injected into its toolbar. A floating
  // control in the shell works the same regardless of what the chrome renders,
  // and it can be reached with F11/Shift+F11-free keyboard too (Alt+Shift+F).
  const [showFull, setShowFull] = useState(false);
  const [mode, setMode] = useState('idle'); // idle | native | expanded
  // The toggle also lives in the proxy's own toolbar (the Games/Settings pill).
  // That pill is React rendered inside the engine bundle, so the patched
  // `kR` nav entry calls this global rather than importing anything.
  const toggleRef = useRef(null);

  // Fullscreen with a fallback that works inside an embedded frame.
  //
  // StarX is often embedded (e.g. a Google Sites page) and that iframe has no
  // `allowfullscreen` attribute, so the Fullscreen API rejects immediately and
  // the button appears broken. There is no way to escape the frame from inside
  // it, so fall back to an "expanded" mode: hide StarX's own chrome and let the
  // page fill the frame edge to edge, plus tell the user how to get true
  // browser fullscreen (Ctrl+Cmd+F / F11).
  function requestNative(el) {
    const req =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.mozRequestFullScreen ||
      el.msRequestFullscreen;
    if (!req) return Promise.reject(new Error('unsupported'));
    return Promise.resolve(req.call(el, { navigationUI: 'hide' }));
  }

  function toggleFullscreen() {
    if (mode === 'expanded') {
      setMode('idle');
      document.documentElement.classList.remove('starx-expanded');
      return;
    }
    if (document.fullscreenElement) {
      const p = document.exitFullscreen && document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
      return;
    }
    requestNative(document.documentElement)
      .catch(() => requestNative(document.body))
      .then(() => setMode('native'))
      .catch(() => {
        // Refused (framed without allowfullscreen): maximised inside the frame.
        setMode('expanded');
        document.documentElement.classList.add('starx-expanded');
        setShowFull(true);
        setTimeout(() => setShowFull(false), 6000);
      });
  }

  // Keep the global the patched toolbar button calls pointing at the live
  // handler, so state updates (and the expanded fallback) still apply.
  useEffect(() => {
    toggleRef.current = toggleFullscreen;
    window.starxToggleFullscreen = () => toggleRef.current && toggleRef.current();
    return () => {
      if (window.starxToggleFullscreen) delete window.starxToggleFullscreen;
    };
  });

  useEffect(() => {
    const sync = () => {
      const on = Boolean(document.fullscreenElement);
      if (on) setMode('native');
      else setMode((m) => (m === 'native' ? 'idle' : m));
      document.documentElement.classList.toggle('starx-fullscreen', on);
    };
    const onKey = (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'Escape' && mode === 'expanded') {
        setMode('idle');
        document.documentElement.classList.remove('starx-expanded');
      }
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('keydown', onKey);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('keydown', onKey);
    };
  }, [mode]);

  // --- Workspace preferences -------------------------------------------------
  // Users can rename the tab and pick their own favicon, and open a clean
  // standalone window with no StarX chrome around the page. Stored per browser.
  const [prefs, setPrefs] = useState({ title: '', icon: '' });
  const [showPrefs, setShowPrefs] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      setPrefs({ title: String(saved.title || ''), icon: String(saved.icon || '') });
    } catch {}
  }, []);

  // Apply the saved title/icon to the shell document as soon as they change.
  // Kept in a ref too, so the standalone window can reuse them without waiting
  // for a re-render.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (prefs.title) document.title = prefs.title;
    if (!prefs.icon) return;
    let link = document.querySelector('link[rel="icon"][data-starx-user-icon]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.dataset.starxUserIcon = '1';
      document.head.appendChild(link);
    }
    link.href = prefs.icon;
  }, [prefs]);

  // The engine bundle sets the tab title and favicon itself once it boots, so a
  // saved preference would be overwritten on every load. Keep the user's choice
  // winning: re-apply it whenever <title> changes, until they reset it.
  useEffect(() => {
    if (!prefs.title || typeof document === 'undefined') return;
    const want = prefs.title;
    const enforce = () => {
      if (document.title !== want) document.title = want;
    };
    const titleEl = document.querySelector('title');
    let observer = null;
    if (titleEl && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(enforce);
      observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    // A few timed re-applies cover the boot sequence, which replaces the title
    // element before the observer can see it.
    const timers = [400, 1200, 2500, 4000, 6000].map((ms) => setTimeout(enforce, ms));
    return () => {
      if (observer) observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [prefs.title]);

  function savePrefs(next) {
    const merged = { ...prefsRef.current, ...next };
    setPrefs(merged);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    } catch {}
  }

  // Open the proxy in its own window: a sized popup of the shell, so the page
  // gets a whole window instead of a tab inside a crowded browser.
  function openStandalone() {
    try {
      const w = window.open('/', 'starx_standalone', 'popup=yes,width=1280,height=840');
      if (!w) return false;
      w.focus();
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    if (!showPrefs) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setShowPrefs(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showPrefs]);

  return (
    <>
      <main id="_jig29al">
        <div className="vaulted-boot">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/starx-logo.png" alt="" aria-hidden="true" />
          <div className="vaulted-boot-bar">
            <div />
          </div>
          <span>{swBlocked ? 'StarX — proxy unavailable here' : 'StarX — connecting…'}</span>
          {swBlocked && (
            <p style={{ maxWidth: '32rem', margin: '0.75rem auto 0', fontSize: '0.8125rem', lineHeight: 1.5, opacity: 0.75, textAlign: 'center' }}>
              This copy is served from a static host that blocks service workers, so pages cannot be proxied here. Run
              StarX from its own domain to browse through it.
            </p>
          )}
        </div>
      </main>

      {showNotice && (
        <section id="vaulted-db-maintenance" role="dialog" aria-modal="true" style={{ display: 'grid' }}>
          <div className="maintenance-card">
            <button className="maintenance-close" type="button" aria-label="Dismiss maintenance notice" onClick={dismiss}>
              ×
            </button>
            <div className="maintenance-icon" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="8" ry="3" />
                <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
                <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
                <path d="M9 8.5c.9.45 1.9.7 3 .7s2.1-.25 3-.7" />
              </svg>
            </div>
            <h1>StarX database maintenance</h1>
            <p>
              The StarX database is currently undergoing maintenance. Services may be limited or unavailable during
              this time.
            </p>
            <div className="maintenance-deadline">
              <span aria-hidden="true">◷</span>
              <span>We expect it to be fixed by the start of December at the latest.</span>
            </div>
            <p className="maintenance-availability">
              <strong>You can still use StarX:</strong> the proxy browser and cloaks remain available.
            </p>
            <button className="maintenance-continue" type="button" onClick={dismiss}>
              Continue to StarX
            </button>
          </div>
        </section>
      )}

      <button
        type="button"
        className="starx-fullscreen-btn starx-fullscreen-fallback"
        onClick={toggleFullscreen}
        aria-label={mode === 'expanded' ? 'Exit fullscreen' : 'Enter fullscreen'}
        aria-pressed={mode !== 'idle'}
        title={mode !== 'idle' ? 'Exit fullscreen (Alt+Shift+F)' : 'Fullscreen (Alt+Shift+F)'}
        data-on={mode !== 'idle' ? '1' : '0'}
      >
        {mode !== 'idle' ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 3H5a2 2 0 0 0-2 2v4" />
            <path d="M15 3h4a2 2 0 0 1 2 2v4" />
            <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
            <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 9V5a2 2 0 0 1 2-2h4" />
            <path d="M21 9V5a2 2 0 0 0-2-2h-4" />
            <path d="M3 15v4a2 2 0 0 0 2 2h4" />
            <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
          </svg>
        )}
        <span className="starx-fullscreen-label">{mode !== 'idle' ? 'Exit' : 'Fullscreen'}</span>
      </button>

      <button
        type="button"
        className="starx-prefs-btn"
        onClick={() => setShowPrefs((v) => !v)}
        aria-label="Workspace preferences"
        aria-pressed={showPrefs}
        title="Workspace preferences"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span className="starx-fullscreen-label">Prefs</span>
      </button>

      {showPrefs && (
        <section className="starx-prefs" role="dialog" aria-modal="false" aria-label="Workspace preferences">
          <header>
            <h2>Workspace</h2>
            <button type="button" className="starx-prefs-close" aria-label="Close" onClick={() => setShowPrefs(false)}>
              ×
            </button>
          </header>

          <label>
            Tab title
            <input
              type="text"
              value={prefs.title}
              maxLength={80}
              placeholder="StarX — by Sm0ke"
              onChange={(e) => savePrefs({ title: e.target.value })}
            />
          </label>

          <label>
            Tab icon URL
            <input
              type="url"
              value={prefs.icon}
              maxLength={500}
              placeholder="/starx-logo.png"
              onChange={(e) => savePrefs({ icon: e.target.value })}
            />
          </label>

          <div className="starx-prefs-row">
            <button
              type="button"
              className="starx-prefs-action"
              onClick={() => {
                savePrefs({ title: '', icon: '' });
                document.title = 'StarX — by Sm0ke';
                document.querySelectorAll('link[rel="icon"][data-starx-user-icon]').forEach((l) => l.remove());
              }}
            >
              Reset
            </button>
            <button type="button" className="starx-prefs-action" onClick={openStandalone}>
              Open standalone window
            </button>
          </div>

          <p className="starx-prefs-note">Saved in this browser. The standalone window removes the tab strip around StarX.</p>
        </section>
      )}

      {showFull && mode === 'expanded' && (
        <p className="starx-fullscreen-note" role="status">
          This page is embedded in a frame, so the browser&apos;s own fullscreen is not available here. StarX is now
          filling the frame — press <strong>Ctrl+Cmd+F</strong> (Mac) or <strong>F11</strong> for true fullscreen.
        </p>
      )}
    </>
  );
}
