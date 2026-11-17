// StarX request-header normalization.
//
// The engine bundle ships its own embedded copy of the libcurl transport
// (public/libcurl/index.js is fetched, but the transport actually used is the
// one compiled into bundle-vaulted-*.js). Both call into this helper, which is
// the last stop before a request is written to the wire.
//
// Why it is needed: every proxied page is served from the proxy origin, so the
// browser stamps Origin/Referer with that origin and marks same-origin traffic
// as "cross-site". Sites that enforce CSRF/origin checks (Google, ChatGPT,
// Roblox, Gemini) reject those requests with 401/403. Rewriting the two headers
// to the target's own origin, and recomputing Sec-Fetch-*, makes the request
// look exactly like a first-party one.
(function () {
  'use strict';

  var PSL2 = /^(co\.uk|co\.jp|com\.au|com\.br|com\.cn|com\.mx|co\.in|co\.nz|co\.za|ne\.jp|or\.jp|com\.tw|com\.hk|com\.sg)$/;

  function registrable(host) {
    host = String(host || '').toLowerCase();
    var p = host.split('.');
    if (p.length <= 2) return host;
    if (PSL2.test(p.slice(-2).join('.'))) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  function findKey(obj, name) {
    name = name.toLowerCase();
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && k.toLowerCase() === name) return k;
    return null;
  }

  function getHeader(obj, name) {
    var k = findKey(obj, name);
    return k === null ? undefined : obj[k];
  }

  function setHeader(obj, name, value) {
    var k = findKey(obj, name);
    if (k !== null && k !== name) delete obj[k];
    obj[name] = value;
  }

  function delHeader(obj, name) {
    var k = findKey(obj, name);
    if (k !== null) delete obj[k];
  }

  // Returns true when the value points back at the proxy itself (and therefore
  // leaks the deployment host into a target's origin check).
  function isProxyUrl(value) {
    return /\/iljfw8\//.test(String(value || ''));
  }

  // Page fetches reach the engine transport with the *proxy* URL still in
  // hand, so the target has to be recovered from the base64url segment before
  // headers can be rewritten. Accepts a URL object, an href string, or a plain
  // target URL.
  function resolveTarget(target) {
    try {
      var href = typeof target === 'string' ? target : (target && target.href) || '';
      if (!href) return null;
      var u = new URL(href, (typeof location !== 'undefined' ? location.href : undefined));
      if (/\/iljfw8\//.test(u.pathname)) {
        var parts = u.pathname.split('/').filter(Boolean);
        for (var i = parts.length - 1; i >= 0 && i >= parts.length - 3; i--) {
          var seg = parts[i];
          if (seg.length < 8) continue;
          var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
          while (b64.length % 4) b64 += '=';
          try {
            var dec = atob(b64);
            if (dec.indexOf('//') === 0) dec = 'https:' + dec;
            if (/^https?:/i.test(dec)) return new URL(dec);
          } catch (e) {}
        }
        return null;
      }
      return u;
    } catch (e) { return null; }
  }

  function normalizeRequestHeaders(headers, target) {
    try {
      if (!headers) return headers;
      var t = resolveTarget(target);
      if (!t) return headers;
      var origin = t.origin;
      target = t;

      // --- Referer -------------------------------------------------------
      var refRaw = getHeader(headers, 'referer');
      var ref = null;
      if (refRaw && !isProxyUrl(refRaw)) {
        try { ref = new URL(refRaw); } catch (e) { ref = null; }
      }
      if (!ref) {
        setHeader(headers, 'Referer', origin + '/');
        ref = new URL(origin + '/');
      }

      var site = 'same-origin';
      if (ref.origin !== origin) {
        site = registrable(ref.hostname) === registrable(target.hostname) ? 'same-site' : 'cross-site';
      }

      // --- Origin --------------------------------------------------------
      // Present => replace unconditionally. Absent => only add it for a
      // cross-origin-capable request (method with a body, or a page fetch that
      // the browser would otherwise have marked). A plain top-level GET that
      // carried no Origin must keep carrying none.
      var hadOrigin = getHeader(headers, 'origin') !== undefined;
      var method = String(getHeader(headers, 'x-starx-method') || '').toUpperCase();
      if (hadOrigin) {
        setHeader(headers, 'Origin', origin);
      } else if (method && method !== 'GET' && method !== 'HEAD') {
        setHeader(headers, 'Origin', origin);
      }

      // --- Sec-Fetch-* ---------------------------------------------------
      if (getHeader(headers, 'sec-fetch-site') !== undefined) {
        setHeader(headers, 'Sec-Fetch-Site', site);
      }
      delHeader(headers, 'sec-fetch-storage-access');
      delHeader(headers, 'x-starx-method');

      // --- Fingerprint ---------------------------------------------------
      var ua = getHeader(headers, 'user-agent');
      if (ua && /Headless/i.test(ua)) {
        setHeader(headers, 'User-Agent',
          ua.replace(/\s*HeadlessChrome\//, ' Chrome/').replace(/\s*Headless\s*/gi, ' '));
      }
      var ch = getHeader(headers, 'sec-ch-ua');
      if (ch && /Headless/i.test(ch)) {
        setHeader(headers, 'Sec-Ch-Ua', ch.replace(/HeadlessChrome/g, 'Google Chrome'));
      }
      return headers;
    } catch (e) { return headers; }
  }


  // --- transport-level entry point ---------------------------------------
  // Called from public/libcurl/index.js' CurlSession.fetch, which is the single
  // function every proxied request passes through. Semantics differ from the
  // header-map API above: params.headers may be absent, and the URL is the proxy
  // URL that still has to be decoded back to the target.
  function resolveProxyTarget(u) {
    try {
      if (!u) return null;
      if (!/\/iljfw8\//.test(u.pathname)) return u;
      var parts = u.pathname.split('/').filter(Boolean);
      for (var i = parts.length - 1; i >= 0 && i >= parts.length - 3; i--) {
        var seg = parts[i];
        if (seg.length < 8) continue;
        var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        try {
          var dec = atob(b64);
          if (dec.indexOf('//') === 0) dec = 'https:' + dec;
          if (/^https?:/i.test(dec)) return new URL(dec);
        } catch (e) {}
      }
      return null;
    } catch (e) { return null; }
  }

  function normalizeTransportRequest(params, target) {
    try {
      var h = params.headers;
      if (h && typeof h === 'object' && !Array.isArray(h)) {
        normalizeRequestHeaders(h, target);
      } else if (typeof Headers !== 'undefined' && h instanceof Headers) {
        var flat = {};
        h.forEach(function (v, k) { flat[k] = v; });
        normalizeRequestHeaders(flat, target);
        params.headers = flat;
      } else {
        // No headers yet: supply the ones a real first-party request would send.
        var built = {};
        var method = String(params.method || 'GET').toUpperCase();
        built.Referer = target.origin + '/';
        if (method !== 'GET' && method !== 'HEAD') built.Origin = target.origin;
        params.headers = built;
      }
      return params;
    } catch (e) { return params; }
  }

  var G = typeof self !== 'undefined' ? self : globalThis;
  // public/libcurl/index.js is its own IIFE and cannot see this closure, so the
  // transport-level pair is also exported as plain globals.
  G.starxNormalizeTransportRequest = normalizeTransportRequest;
  G.starxResolveProxyTarget = resolveProxyTarget;

  var bricks = G.starxBricks || {};
  bricks.normalizeRequestHeaders = normalizeRequestHeaders;
  bricks.registrableHost = registrable;
  bricks.resolveTarget = resolveTarget;
  bricks.resolveProxyTarget = resolveProxyTarget;
  G.starxBricks = bricks;
})();
