// StarX service worker v6 — strips SRI/nonce + CSP from proxied HTML.
// --- StarX ad / telemetry short-circuit -----------------------------------
// Proxied requests live under /<prefix>/.../<base64url(target)>. Decode the
// target host on every proxied navigation/subresource and answer with an empty
// 204 when it belongs to a known ad or telemetry network. Doing this in the
// worker means the request never leaves the browser.
var STARX_BLOCK_HOSTS=[
 "doubleclick.net","googlesyndication.com","google-analytics.com","googletagmanager.com",
 "googleadservices.com","analytics.google.com","adservice.google.com",
 "hotjar.com","hotjar.io","sentry.io","sentry-cdn.com","ingest.sentry.io",
 "mcs.tiktokv.us","mcs-va.tiktokv.us","mcs-sg.tiktokv.us","mcs-zs.tiktokv.us",
 "mon.tiktokv.com","mon.tiktokv.us","log.tiktokv.com","analytics.tiktok.com",
 "scorecardresearch.com","quantserve.com","criteo.com","criteo.net","taboola.com",
 "outbrain.com","moatads.com","adsrvr.org","rubiconproject.com","pubmatic.com",
 "adnxs.com","casalemedia.com","smartadserver.com","yieldmo.com","3lift.com",
 "amazon-adsystem.com","adroll.com","clarity.ms","bat.bing.com","connect.facebook.net"
];
var STARX_BLOCK_RE=/(^|\.)(doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|googleadservices\.com|adservice\.google\.com|hotjar\.com|hotjar\.io|sentry\.io|sentry-cdn\.com|scorecardresearch\.com|quantserve\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|moatads\.com|adsrvr\.org|rubiconproject\.com|pubmatic\.com|adnxs\.com|casalemedia\.com|smartadserver\.com|yieldmo\.com|3lift\.com|amazon-adsystem\.com|adroll\.com|mcs\.tiktokv\.us|mcs-[a-z]+\.tiktokv\.us|mon\.tiktokv\.(com|us)|log\.tiktokv\.com|analytics\.tiktok\.com|bat\.bing\.com|connect\.facebook\.net)$/i;
function starxTargetUrl(url){
  try{
    var u=new URL(url);
    var parts=u.pathname.split("/").filter(Boolean);
    // last segment is the base64url-encoded target URL
    for(var i=parts.length-1;i>=0&&i>=parts.length-3;i--){
      var seg=parts[i];
      if(seg.length<8) continue;
      var b64=seg.replace(/-/g,"+").replace(/_/g,"/");
      while(b64.length%4) b64+="=";
      try{
        var dec=atob(b64);
        if(dec.indexOf("http")===0||dec.indexOf("//")===0){
          if(dec.indexOf("//")===0) dec="https:"+dec;
          return dec;
        }
      }catch(e){}
    }
  }catch(e){}
  return "";
}
function starxTargetHost(url){
  var dec=starxTargetUrl(url);
  if(!dec) return "";
  try{ return new URL(dec).hostname.toLowerCase(); }catch(e){ return ""; }
}
function starxIsBlocked(url){
  var dec=starxTargetUrl(url);
  if(!dec) return false;
  if(STARX_BLOCK_PATH_RE.test(dec)) return true;
  return STARX_BLOCK_RE.test(starxTargetHost(url));
}
// Some third-party SDKs are blocked by URL rather than host: OneTrust's consent
// stub (otSDKStub.js) is served from the *first-party* domain in several sites
// (Discord ships it at /assets/oneTrust/...) but crashes under a rewriting proxy
// because document.currentScript is null inside its async init. Blocking the
// SDK is the same trade-off as blocking any ad/consent vendor.
var STARX_BLOCK_PATH_RE=/\/onetrust\/|otsdkstub|otbannersdk|optanon|cookielaw\.org|onetrust\.com|consent\.trustarc|cookiebot/i;

function starxBlockedResponse(){
  return new Response(null,{status:204,statusText:"No Content",headers:{"Cache-Control":"max-age=86400"}});
}
// Some sites are gated on their own advertising: CloudMoon's cloud-gaming
// launcher refuses to start a stream ("Ad blocked. Unlimited play time is
// unavailable.") and then the game page shows "Unable to Join Game" whenever a
// request to its ad network is short-circuited. For those destinations we skip
// the ad/telemetry short-circuit entirely and let the requests go through the
// proxy, exactly as a normal browser would. Detected from the requesting
// page's URL, which is itself a proxied URL carrying the real target.
var STARX_ADBLOCK_EXEMPT=/(^|\.)(cloudmoonapp\.com|cloudmoon\.net|nenly\.cn|viewoncloud\.com|cloudbatata\.com|geometry\.today|nowgg\.fun|now\.gg)$/i;
function starxPageHost(url){
  var dec=starxTargetUrl(url);
  if(!dec) return "";
  try{ return new URL(dec).hostname.toLowerCase(); }catch(e){ return ""; }
}
// Frames we know are serving an ad-gated site, keyed by client id. Populated
// when the frame's *document* request passes through the worker: subresource
// requests then carry that frame's clientId, so we can recognise them without
// relying on Referer (which the browser trims to the bare origin, losing the
// proxied URL that identifies the site).
var STARX_EXEMPT_CLIENTS={};
var STARX_EXEMPT_TTL=30*60*1000;
function starxExemptMark(id,on){
  if(!id) return;
  if(on) STARX_EXEMPT_CLIENTS[id]=Date.now()+STARX_EXEMPT_TTL;
  else delete STARX_EXEMPT_CLIENTS[id];
}
function starxNoteFrame(o){
  try{
    var req=o.request,dest=String(req.destination||"");
    if(dest!=="iframe"&&dest!=="document") return;
    var h=starxPageHost(req.url);
    if(!h||!STARX_ADBLOCK_EXEMPT.test(h)) return;
    starxExemptMark(req.clientId,true);
    starxExemptMark(o.resultingClientId,true);
  }catch(e){}
}
function starxExemptLive(id){
  var exp=STARX_EXEMPT_CLIENTS[id];
  if(!exp) return false;
  if(exp<Date.now()){ delete STARX_EXEMPT_CLIENTS[id]; return false; }
  return true;
}
async function starxAdBlockExempt(req,event){
  try{
    var dest=String(req.destination||"");
    // A frame/document navigation to an ad-gated site: remember its clients.
    if(dest==="iframe"||dest==="document"){
      var navHost=starxPageHost(req.url);
      if(navHost&&STARX_ADBLOCK_EXEMPT.test(navHost)){
        starxExemptMark(req.clientId,true);
        starxExemptMark(event&&event.resultingClientId,true);
        return true;
      }
    }
    if(starxExemptLive(req.clientId)) return true;
    var h=starxPageHost(req.referrer||"");
    if(h&&STARX_ADBLOCK_EXEMPT.test(h)) return true;
    if(dest==="iframe"||dest==="document") return false;
    var cid=req.clientId;
    if(cid){
      var c=await clients.get(cid);
      if(c&&c.url){
        var h2=starxPageHost(c.url);
        if(h2&&STARX_ADBLOCK_EXEMPT.test(h2)) return true;
      }
    }
  }catch(e){}
  return false;
}
// Wrap a proxy route result with the response finaliser, tolerating both
// promise and plain-Response return values.
function starxFinalizeResult(p,url){
  try{
    return Promise.resolve(p).then(function(r){
      try{ return starxFinalizeResponse({body:r.body,status:r.status,statusText:r.statusText,url:url},r.headers); }
      catch(e){ return r; }
    });
  }catch(e){ return p; }
}
// Returns a response promise when this request belongs to the proxy, else null
// so the browser handles it normally (Next.js assets, HMR, service worker itself).
// Stamp an exempt request so the controller's own blocklist lets it through.
function starxStampAdOk(o){
  try{
    var u=o.request.url;
    if(u.indexOf("starxadok")>=0) return o;
    var nu=u+(u.indexOf("?")<0?"?":"&")+"starxadok=1";
    return {request:new Request(nu,o.request),clientId:o.clientId,resultingClientId:o.resultingClientId};
  }catch(e){ return o; }
}
function starxRouteResult(o,exempt){
  var target=exempt?starxStampAdOk(o):o;
  var r=null;
  try{ if(typeof _ebvd0bt!=="undefined"&&_ebvd0bt.shouldRoute(target)) r=_ebvd0bt.route(target); }catch(e){}
  if(!r){ try{ if(typeof _yta30ly!=="undefined"&&_yta30ly.shouldRoute(target)) r=_yta30ly.route(target); }catch(e){} }
  var u="";
  try{ u=target&&target.request&&target.request.url?target.request.url:""; }catch(e){}
  return r?starxFinalizeResult(r,u):null;
}


// Strip SRI hashes / nonces from a proxied HTML document.
//
// The wasm rewriter only rewrites URLs and DOM APIs; it leaves `integrity` and
// `nonce` attributes in the served markup, and a proxied script's bytes never
// match the hash of the origin response, so Chrome refuses to execute Discord's
// (and any other SRI-protected site's) bundles. The proxy body is already
// decompressed by the transport (only the header is stale), so a plain text
// pass is safe and cheap.
// Injected into every proxied HTML document. Some sites (Discord/Webflow) put
// SRI hashes back on script/link elements at runtime; under a proxy the bytes
// never match, so Chrome refuses to execute them. The guard makes `integrity`
// and `nonce` un-settable and sweeps any element that still has them.
var STARX_GUARD_JS=[
 // --- CloudMoon: launch settings -------------------------------------------
 // Seeded ahead of the guard below (its __starxGuard early-return would skip this).
 // Body lives in tmp/cmguard.js during development; it is inlined as one string
 // so the array concatenation cannot mangle its escaping.
 "// CloudMoon launch settings, injected ahead of every other page script.\n//\n// Two settings are required for the launcher to work inside the proxy:\n//   selectedServer   - it throws on 0/\"Select Server\" and reports that as\n//                      \"Failed to connect to game server\".\n//   newWindowLaunch  - \"false\" makes it load the run-site in this frame; the\n//                      popup path assigns popup.location.href, and the proxy's\n//                      popup has no usable location, so that throws\n//                      \"Cannot set properties of undefined (setting 'href')\".\n//\n// Timing matters: at document start the proxy has not yet installed the per-site\n// storage shim, so a write here lands in the shell's storage and CloudMoon never\n// sees it. So seed again once the document is ready, and keep retrying briefly\n// and on the first click, by which time the real store is in place.\n(function () {\n  var cm = /(^|\\.)(cloudmoonapp\\.com|cloudmoon\\.net|nenly\\.cn|viewoncloud\\.com|cloudbatata\\.com)$/i;\n\n  function hostOf() {\n    try {\n      var p = location.pathname.split('/').filter(Boolean);\n      var seg = p[p.length - 1] || '';\n      if (!seg) return '';\n      seg = seg.replace(/-/g, '+').replace(/_/g, '/');\n      while (seg.length % 4) seg += '=';\n      var dec = atob(seg);\n      return /^https?:/i.test(dec) ? new URL(dec).hostname.toLowerCase() : '';\n    } catch (e) {\n      return '';\n    }\n  }\n\n  if (!cm.test(hostOf())) return;\n\n  function apply() {\n    try {\n      var sel = localStorage.getItem('selectedServer');\n      if (!sel || parseInt(sel, 10) === 0) localStorage.setItem('selectedServer', '23');\n    } catch (e) {}\n    try {\n      if (localStorage.getItem('newWindowLaunch') === null) {\n        localStorage.setItem('newWindowLaunch', 'false');\n      }\n    } catch (e) {}\n  }\n\n  // Keep the server dropdown in step with the stored value, and store whatever\n  // the player picks so their choice wins over the seeded default.\n  function syncSelect() {\n    try {\n      var s = document.querySelector('.server-select select');\n      if (!s) return;\n      var cur = parseInt(localStorage.getItem('selectedServer') || '0', 10);\n      if (cur && String(s.value) !== String(cur)) {\n        s.value = String(cur);\n        s.dispatchEvent(new Event('change', { bubbles: true }));\n      }\n      if (!s.__starxCmBound) {\n        s.__starxCmBound = 1;\n        s.addEventListener('change', function () {\n          try { localStorage.setItem('selectedServer', String(s.value)); } catch (e) {}\n        });\n      }\n    } catch (e) {}\n  }\n\n  function tick() {\n    apply();\n    syncSelect();\n  }\n\n  apply();\n  document.addEventListener('DOMContentLoaded', tick);\n  window.addEventListener('load', tick);\n  // The launcher reads storage synchronously inside its click handler, so make\n  // sure the values are in place the instant Play is pressed.\n  document.addEventListener('click', tick, true);\n\n  // Retry while the SPA boots; the per-site store only exists after that.\n  var n = 0;\n  var timer = setInterval(function () {\n    tick();\n    if (++n > 40) clearInterval(timer);\n  }, 400);\n})();\n",
 "(function(){",
 "if(window.__starxGuard)return;window.__starxGuard=1;",
 "var BAD=/^(integrity|nonce)$/i;",
 "try{",
 "var sa=Element.prototype.setAttribute;",
 "Element.prototype.setAttribute=function(k,v){if(BAD.test(String(k)))return;return sa.call(this,k,v)};",
 "var san=Element.prototype.setAttributeNode;",
 "Element.prototype.setAttributeNode=function(a){try{if(a&&BAD.test(String(a.name)))return null}catch(e){}return san.call(this,a)};",
 "var sao=Element.prototype.setAttributeNodeNS;Element.prototype.setAttributeNodeNS=function(a){try{if(a&&BAD.test(String(a.name)))return null}catch(e){}return sao.call(this,a)};",
 "var SAN=Element.prototype.setAttributeNS;Element.prototype.setAttributeNS=function(ns,k,v){try{if(BAD.test(String(k)))return}catch(e){}return SAN.call(this,ns,k,v)};",
 "[HTMLScriptElement,HTMLLinkElement,HTMLIFrameElement,HTMLElement].forEach(function(C){if(!C)return;['integrity','nonce'].forEach(function(p){try{var d=Object.getOwnPropertyDescriptor(C.prototype,p);if(d&&d.set)Object.defineProperty(C.prototype,p,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(){}})}catch(e){}})});",
 "}catch(e){}",
 "function strip(h){try{return String(h).replace(/(<(?:script|link)\\b[^>]*?)\\sintegrity\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi,'$1').replace(/(<(?:script|link)\\b[^>]*?)\\snonce\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi,'$1')}catch(e){return h}}",
 "try{var dw=document.write;document.write=function(){try{for(var i=0;i<arguments.length;i++)arguments[i]=strip(arguments[i])}catch(e){}return dw.apply(document,arguments)};}catch(e){}",
 "try{var ih=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');if(ih&&ih.set)Object.defineProperty(Element.prototype,'innerHTML',{configurable:true,enumerable:ih.enumerable,get:ih.get,set:function(v){return ih.set.call(this,strip(v))}});}catch(e){}",
 "function clean(n){try{if(n&&n.nodeType===1&&n.removeAttribute){if(n.hasAttribute('integrity'))n.removeAttribute('integrity');if(n.hasAttribute('nonce'))n.removeAttribute('nonce')}}catch(e){}}",
 "function scan(r){try{if(!r||r.nodeType!==1)return;clean(r);if(r.querySelectorAll){var a=r.querySelectorAll('[integrity],[nonce]');for(var i=0;i<a.length;i++)clean(a[i])}}catch(e){}}",
 // Cleaning after insertion is too late for <link>/<script>: the browser starts
 // the request (and enforces SRI) as soon as the node lands in the tree. Sweep
 // the node *before* it is attached, on every insertion path.
 "function pre(n){try{if(!n)return n;if(n.nodeType===1)scan(n);else if(n.nodeType===11&&n.querySelectorAll)scan(n)}catch(e){}return n}",
 "try{var ac=Node.prototype.appendChild;Node.prototype.appendChild=function(n){return ac.call(this,pre(n))};}catch(e){}",
 "try{var ib=Node.prototype.insertBefore;Node.prototype.insertBefore=function(n,r){return ib.call(this,pre(n),r)};}catch(e){}",
 "try{var rc=Node.prototype.replaceChild;Node.prototype.replaceChild=function(n,o){return rc.call(this,pre(n),o)};}catch(e){}",
 // ParentNode.append/prepend exist on Element, Document and DocumentFragment as
 // *separate* methods, each with its own brand check. Patching them with a
 // single wrapper that applies Element's implementation to `this` throws
 // "Illegal invocation" whenever a DocumentFragment is used — which is exactly
 // what React does when hydrating, so Brave Search died on hydration. Wrap each
 // prototype with its OWN original method.
 "['Element','Document','DocumentFragment'].forEach(function(k){var C=window[k];if(!C)return;['append','prepend'].forEach(function(m){try{var own=Object.getOwnPropertyDescriptor(C.prototype,m);if(!own||typeof own.value!=='function')return;var f=own.value;Object.defineProperty(C.prototype,m,{configurable:true,enumerable:own.enumerable,writable:true,value:function(){for(var i=0;i<arguments.length;i++)arguments[i]=pre(arguments[i]);return f.apply(this,arguments)}});}catch(e){}});});",
 "['before','after','replaceWith'].forEach(function(m){try{var f=Element.prototype[m];if(!f)return;Element.prototype[m]=function(){for(var i=0;i<arguments.length;i++)arguments[i]=pre(arguments[i]);return f.apply(this,arguments)};}catch(e){}});",
 "try{var iae=Element.prototype.insertAdjacentElement;Element.prototype.insertAdjacentElement=function(p,n){return iae.call(this,p,pre(n))};}catch(e){}",
 "try{var iah=Element.prototype.insertAdjacentHTML;Element.prototype.insertAdjacentHTML=function(p,h){return iah.call(this,p,strip(h))};}catch(e){}",
 "try{var ohe=Object.getOwnPropertyDescriptor(Element.prototype,'outerHTML');if(ohe&&ohe.set)Object.defineProperty(Element.prototype,'outerHTML',{configurable:true,enumerable:ohe.enumerable,get:ohe.get,set:function(v){return ohe.set.call(this,strip(v))}});}catch(e){}",
 "try{var cn=Node.prototype.cloneNode;Node.prototype.cloneNode=function(d){return pre(cn.call(this,d))};}catch(e){}",
 "try{var an=Document.prototype.adoptNode;Document.prototype.adoptNode=function(n){return an.call(this,pre(n))};}catch(e){}",
 "try{var im=Document.prototype.importNode;Document.prototype.importNode=function(n,d){return im.call(this,pre(n),d)};}catch(e){}",
 "try{var ce=Document.prototype.createElement;Document.prototype.createElement=function(t,o){var el=ce.call(this,t,o);return el};}catch(e){}",
 "function start(){",
 "scan(document.documentElement);",
 "try{",
 "new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==='attributes'){clean(m.target)}else{for(var j=0;j<m.addedNodes.length;j++)scan(m.addedNodes[j])}}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['integrity','nonce']});",
 "}catch(e){}",
 "}",
 // --- link / popup handling ------------------------------------------------
 // A <a target="_blank"> or window.open() inside a proxied page must become a
 // StarX tab. The engine's popup plugin normally does that, but when a click is
 // synthesised (middle-click, keyboard activation, a site calling click() on an
 // anchor) the event can slip past it, the browser then opens a real window on
 // the *rewritten proxy URL*, and because that URL is not a StarX route Chrome
 // shows an empty frame — the "blank page" bug.
 //
 // This guard is the last line of defence: it intercepts the click, asks the
 // parent shell to open a StarX tab, and if the shell does not answer it sends
 // the tab through the proxy's own rw route so the link still renders.
 "try{",
 "var sxNav=function(href){try{",
 "if(!href)return false;",
 "var u=new URL(href,location.href);",
 "if(!/^https?:$/i.test(u.protocol))return false;",
 // Ask the StarX shell first: it knows how to open a real, visible tab.
 "try{var ask=window.top;if(ask&&ask!==window&&ask.__starxOpenProxied){var r=ask.__starxOpenProxied(u.href);if(r!==false)return true}}catch(e){}",
 "try{if(window.parent&&window.parent!==window&&window.parent.__starxOpenProxied){var r2=window.parent.__starxOpenProxied(u.href);if(r2!==false)return true}}catch(e){}",
 // Fallback: navigate this frame through the proxy route instead of a raw URL.
 "try{location.href=u.href}catch(e){}",
 "return true}catch(e){return false}};",
 "var onLink=function(ev){try{",
 "if(ev.defaultPrevented)return;",
 "var t=ev.target&&ev.target.closest?ev.target.closest('a[href]'):null;",
 "if(!t)return;",
 "if(t.hasAttribute('download'))return;",
 "var blank=/^_(blank|new)$/i.test(t.getAttribute('target')||'');",
 "if(!blank&&ev.type==='click'&&ev.button===0&&!ev.ctrlKey&&!ev.metaKey&&!ev.shiftKey)return;",
 "var href=t.href;if(!href||!/^https?:/i.test(href))return;",
 "if(sxNav(href)){ev.preventDefault();ev.stopPropagation()}",
 "}catch(e){}};",
 "document.addEventListener('click',onLink,true);",
 "document.addEventListener('auxclick',onLink,true);",
 // window.open is left alone when the engine already stubbed it; only handle the
 // case where the real Window.open still exists (guard ran before the engine).
 "try{var wopen=window.open;if(typeof wopen==='function'&&!wopen.__starx){var wrapped=function(u,n,f){try{if(u&&sxNav(String(u)))return null}catch(e){}return wopen.call(window,u,n,f)};wrapped.__starx=1;try{window.open=wrapped}catch(e){}} }catch(e){}",
 "}catch(e){}",
 // Gemini's module loader re-reads the .src of its own bootstrap script
 // (<script id="base-js">) and asserts it still looks like `.../_/js/k=...`.
 // Under the proxy that URL is a base64-encoded route, the assertion fails, and
 // the app throws before rendering anything (the "Fa" error with an empty body).
 // Report the original upstream URL for that single element so the check passes;
 // every other script keeps the real proxy URL it needs to load.
 "try{",
 "var d0=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');",
 "if(d0&&d0.get&&!HTMLScriptElement.prototype.__starxSrcFix){",
 "var sdec=function(u){try{",
 "var m=String(u).match(/([A-Za-z0-9_-]{40,})\\/?(?:[?#].*)?$/);if(!m)return '';",
 "var b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';",
 "var t=decodeURIComponent(escape(atob(b)));",
 "return /^https?:\\/\\//i.test(t)&&/google\\.com|gstatic\\.com/i.test(t)?t:''",
 "}catch(e){return ''}};",
 "Object.defineProperty(HTMLScriptElement.prototype,'src',{configurable:true,",
 "get:function(){var v=d0.get.call(this);try{if(this.id==='base-js'){var o=sdec(v);if(o)return o}}catch(e2){}return v},",
 "set:function(x){try{if(d0.set)d0.set.call(this,x);else this.setAttribute('src',x)}catch(e3){}}});",
 "HTMLScriptElement.prototype.__starxSrcFix=1;",
 "}",
 "}catch(e){}",
 // The engine installs a *per-element* own `src` property on rewritten
 // scripts, which shadows the prototype getter above. Re-define it on the
 // Gemini bootstrap element itself, and keep re-applying briefly in case the
 // engine rewrites the element after we run.
 "try{",
 "var d1=Object.getOwnPropertyDescriptor(Element.prototype,'getAttribute');",
 "var fixEl=function(el){",
 "try{",
 "if(!el||el.__starxBaseJsFix)return el;",
 "var raw=d1&&d1.call?d1.call(el,'src'):el.getAttribute('src');",
 "var m=String(raw||'').match(/([A-Za-z0-9_-]{40,})\\/?(?:[?#].*)?$/);",
 "if(!m)return el;",
 "var b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';",
 "var orig=decodeURIComponent(escape(atob(b)));",
 "if(!/^https?:\\/\\//i.test(orig))return el;",
 "Object.defineProperty(el,'src',{configurable:true,enumerable:true,",
 "get:function(){return orig},",
 "set:function(){}});",
 "el.__starxBaseJsFix=1;",
 "}catch(e4){}",
 "return el",
 "};",
 "var fixBaseJs=function(){",
 "try{var el=document.getElementById('base-js');if(el)fixEl(el)}catch(e5){}",
 "};",
 // Gemini reads the element's src the instant its bundle executes, which can be
 // before DOMContentLoaded. Hand it the patched element at the moment it asks.
 "try{",
 "var gid=Document.prototype.getElementById;",
 "if(gid&&!Document.prototype.__starxGidFix){",
 "Document.prototype.getElementById=function(id){",
 "var el=gid.call(this,id);",
 "if(id==='base-js')return fixEl(el);",
 "return el",
 "};",
 "Document.prototype.__starxGidFix=1;",
 "}",
 "}catch(e6){}",
 "fixBaseJs();",
 "document.addEventListener('DOMContentLoaded',fixBaseJs);",
 "window.addEventListener('load',fixBaseJs);",
 "for(var bi=0;bi<20;bi++)setTimeout(fixBaseJs,bi*500);",
 "}catch(e){}",
 "start();",
 "})();"
].join("");

function starxStripSecurityAttrs(html){
  var out=html
    .replace(/(<(?:script|link)\b[^>]*?)\sintegrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,"$1")
    .replace(/(<(?:script|link)\b[^>]*?)\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,"$1")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,"");
  // The guard has to execute before every other document script, including the
  // proxy's own bootstrap, and before the preload scanner can act on a
  // <link rel=preload integrity>. Put it immediately after <head> (never before
  // <!doctype>, which would drop the document into quirks mode); fall back to
  // after <html>, then to the very front of the document.
  // The rewriter may already have injected a guard (this function can run more
  // than once on the same document). Drop any existing copy first so the page
  // does not end up executing the guard twice.
  out=out.replace(/<script data-starx-guard>[\s\S]*?<\/script>/gi,"");
  var tag="<script data-starx-guard>"+STARX_GUARD_JS+"</script>";
  if(/<head[^>]*>/i.test(out)) out=out.replace(/<head[^>]*>/i,function(m){return m+tag});
  else if(/<html[^>]*>/i.test(out)) out=out.replace(/<html[^>]*>/i,function(m){return m+tag});
  else out=tag+out;
  return starxFixDoctype(out);
}

// Force the doctype back to the very front of the document.
//
// The proxy's HTML rewriter prepends its own bootstrap <script> tags to the
// document root, i.e. *above* <!doctype html>. The HTML parser then ignores the
// doctype, the document loads in quirks mode (document.compatMode ===
// "BackCompat"), and sites that check for that refuse to boot. Gemini is the
// clearest example: it logs "detected quirky document structure parsing" and
// throws before rendering, leaving an empty body.
//
// Moving the doctype to the front fixes the mode without changing behaviour:
// content that preceded <html> is hoisted by the parser into the start of
// <head>, so those scripts still run first and in the same order.
function starxFixDoctype(html){
  try{
    var m=/^(\uFEFF?[ \t\r\n]*)([\s\S]*)$/.exec(html);
    var lead=m?m[1]:"", rest=m?m[2]:html;
    if(/^<!doctype/i.test(rest)) return html;
    var dt=rest.match(/<!doctype[^>]*>/i);
    if(dt) rest=dt[0]+rest.replace(dt[0],"");
    else rest="<!doctype html>"+rest;
    return lead+rest;
  }catch(e){ return html; }
}

function starxHeaderGet(headers,name){
  try{
    if(headers instanceof Headers) return headers.get(name)||"";
    if(Array.isArray(headers)){
      for(var i=0;i<headers.length;i++) if(String(headers[i][0]).toLowerCase()===name) return String(headers[i][1]||"");
      return "";
    }
    for(var k in headers) if(String(k).toLowerCase()===name) return String(headers[k]||"");
  }catch(e){}
  return "";
}

// --- StarX: outgoing header normalization ---------------------------------
// The browser stamps requests with the *proxy* origin (http://host:3000) in
// Origin/Referer and calls them cross-site, because the document's URL is the
// proxy URL. Targets that enforce CSRF/origin checks reject those with 401/403,
// which is what broke Google, ChatGPT, Roblox and Gemini logins. This worker is
// the one place that sees every proxied request (documents, XHR, media,
// workers) together with its decodable target URL, so rewrite the headers here.
function starxRegistrableHost(host){
  try{
    host=String(host||"").toLowerCase();
    var p=host.split(".");
    if(p.length<=2) return host;
    if(/^(co\.uk|co\.jp|com\.au|com\.br|com\.cn|com\.mx|co\.in|co\.nz|co\.za|ne\.jp|or\.jp)$/.test(p.slice(-2).join("."))) return p.slice(-3).join(".");
    return p.slice(-2).join(".");
  }catch(e){ return String(host||""); }
}
function starxNormalizeRequestHeaders(pairs,rawUrl){
  try{
    var target=starxTargetUrl(rawUrl);
    if(!target) return pairs;
    var t;
    try{ t=new URL(target); }catch(e){ return pairs; }
    var origin=t.origin, refRaw="", out=[], method="";
    for(var i=0;i<pairs.length;i++){
      var k=pairs[i][0], v=pairs[i][1], lk=String(k).toLowerCase();
      // Chrome-only third-party hint; some APIs treat it as "no storage access".
      if(lk==="sec-fetch-storage-access") continue;
      if(lk==="origin") continue;
      if(lk==="referer"){ refRaw=String(v||""); continue; }
      if(lk==="sec-fetch-site") continue;
      if(lk==="user-agent"&&/Headless/i.test(String(v))){
        out.push([k,String(v).replace(/\s*HeadlessChrome\//," Chrome/").replace(/\s*Headless\s*/gi," ")]);
        continue;
      }
      if(lk==="sec-ch-ua"&&/Headless/i.test(String(v))){
        out.push([k,String(v).replace(/HeadlessChrome/g,"Google Chrome")]);
        continue;
      }
      out.push([k,v]);
    }
    // Same-site determination from the (rewritten) referrer, if it is usable.
    var site="same-origin", ref=null;
    if(refRaw&&!/\/iljfw8\//.test(refRaw)){ try{ ref=new URL(refRaw); }catch(e){} }
    if(ref&&ref.origin!==origin){
      site=starxRegistrableHost(ref.hostname)===starxRegistrableHost(t.hostname)?"same-site":"cross-site";
    }
    out.push(["Origin",origin]);
    if(ref) out.push(["Referer",ref.href.indexOf(origin)===0?ref.href:origin+"/"]);
    else out.push(["Referer",origin+"/"]);
    out.push(["Sec-Fetch-Site",site]);
    return out;
  }catch(e){ return pairs; }
}

async function starxFinalizeResponse(x,headers){
  var ct=starxHeaderGet(headers,"content-type").toLowerCase();
  var isHtml=ct.indexOf("text/html")===0&&x.status===200&&x.body!=null;
  // CDNs that mirror GitHub (jsDelivr and friends) serve .html files as
  // text/plain with X-Content-Type-Options: nosniff, so a game loaded from one
  // renders as source code instead of running. These responses arrive inside a
  // proxied frame, where a document is parsed as HTML anyway, so upgrade the
  // type when the body is plainly an HTML document. Detection is on the body
  // rather than the URL: the request URL here is the proxy route, and the real
  // target is base64-encoded in its last path segment.
  var looksTextual=ct.indexOf("text/html")===0||ct.indexOf("text/plain")===0||ct.indexOf("text/txt")===0||ct.indexOf("application/octet-stream")===0||ct==="";
  if(!isHtml&&x.status===200&&x.body!=null&&looksTextual){
    try{
      var sniff="";
      if(typeof x.body==="string") sniff=x.body.slice(0,400);
      else if(x.body&&typeof x.body.getReader==="function"){
        var rd=x.body.getReader();
        var chunk=await rd.read();
        if(!chunk.done&&chunk.value) sniff=new TextDecoder("utf-8").decode(chunk.value.slice(0,400));
        var rest=chunk.done?[]:[chunk.value];
        var parts=rest.slice();
        // Rebuild a stream that replays what was read, then continues.
        x={body:new ReadableStream({start:function(c){parts.forEach(function(p){if(p)c.enqueue(p)});function pump(){return rd.read().then(function(r2){if(r2.done)c.close();else{c.enqueue(r2.value);return pump()}})}pump().catch(function(e){try{c.error(e)}catch(e2){}})}}),status:x.status,statusText:x.statusText};
      }
      var head=String(sniff).replace(/^\uFEFF/,"").replace(/^\s+/,"").toLowerCase();
      if(head.indexOf("<!doctype html")===0||head.indexOf("<html")===0||head.indexOf("<!--")===0&&head.indexOf("<html")>0){
        isHtml=true;
      }
    }catch(e){}
  }
  if(!isHtml) return new Response(x.body,{status:x.status,statusText:x.statusText,headers:headers});
  try{
    var text=typeof x.body==="string"?x.body:await new Response(x.body).text();
    if(text.indexOf("integrity=")<0&&text.indexOf("nonce=")<0&&ct.indexOf("content-security")<0){
      // Still rebuild: content-encoding/length are stale for a decoded body.
    }
    var out=starxStripSecurityAttrs(text);
    var h2=new Headers();
    if(headers instanceof Headers){ headers.forEach(function(v,k){h2.set(k,v)}); }
    else if(Array.isArray(headers)){ for(var j=0;j<headers.length;j++) h2.set(String(headers[j][0]),String(headers[j][1])); }
    else { for(var kk in headers) h2.set(String(kk),String(headers[kk])); }
    ["content-encoding","content-length","etag","content-md5","accept-ranges","content-range"].forEach(function(k){h2.delete(k)});
    h2.set("content-type","text/html; charset=utf-8");
    return new Response(out,{status:x.status,statusText:x.statusText,headers:h2});
  }catch(e){
    return new Response(x.body,{status:x.status,statusText:x.statusText,headers:headers});
  }
}

self.starxIsBlocked=starxIsBlocked;self.starxTargetHost=starxTargetHost;self.starxBlockedResponse=starxBlockedResponse;
self.starxFinalizeResponse=starxFinalizeResponse;self.starxStripSecurityAttrs=starxStripSecurityAttrs;
navigator.userAgent.includes("Firefox")&&Object.defineProperty(globalThis,"crossOriginIsolated",{value:!0,writable:!1}),(()=>{var o="sapphire_extensions",w=2,p="extensions",g="extension_files",f="extension_storage",m="extension_state",v=null;function b(){return v||(v=new Promise((l,s)=>{const e=indexedDB.open(o,w);e.onupgradeneeded=()=>{const t=e.result;t.objectStoreNames.contains(p)||t.createObjectStore(p,{keyPath:"id"}),t.objectStoreNames.contains(g)||t.createObjectStore(g),t.objectStoreNames.contains(m)||t.createObjectStore(m),t.objectStoreNames.contains(f)||t.createObjectStore(f)},e.onsuccess=()=>l(e.result),e.onerror=()=>s(e.error)}),v)}async function j(l,s){const e=await b();return new Promise((t,r)=>{const d=e.transaction(l,"readonly").objectStore(l).get(s);d.onsuccess=()=>t(d.result),d.onerror=()=>r(d.error)})}async function R(l){const s=await b();return new Promise((e,t)=>{const i=s.transaction(l,"readonly").objectStore(l).getAllKeys();i.onsuccess=()=>e(i.result),i.onerror=()=>t(i.error)})}var n={js:"application/javascript",mjs:"application/javascript",cjs:"application/javascript",css:"text/css",html:"text/html",htm:"text/html",xhtml:"application/xhtml+xml",json:"application/json",map:"application/json",txt:"text/plain",xml:"application/xml",csv:"text/csv",md:"text/markdown",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",svg:"image/svg+xml",webp:"image/webp",avif:"image/avif",bmp:"image/bmp",ico:"image/x-icon",cur:"image/x-icon",woff:"font/woff",woff2:"font/woff2",ttf:"font/ttf",otf:"font/otf",eot:"application/vnd.ms-fontobject",wasm:"application/wasm",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",oga:"audio/ogg",m4a:"audio/mp4",flac:"audio/flac",mp4:"video/mp4",webm:"video/webm",ogv:"video/ogg",pdf:"application/pdf",zip:"application/zip"};function a(l){const s=l.split(/[?#]/)[0].split(".").pop()?.toLowerCase()??"";return n[s]??"application/octet-stream"}var c="/~/sx/";function h(l){if(!l.startsWith(c))return null;const s=l.slice(c.length),e=s.indexOf("/");if(e===-1)return null;const t=s.slice(0,e),r=decodeURIComponent(s.slice(e+1));return!t||!r?null:{extId:t,path:r}}var u=new Map;function x(l){const s=l.match(/^\/~\/sx\/([^/]+)\/__bootstrap__$/);return s?s[1]:null}function $(l){try{const s=new URL(l.request.url);return s.pathname.startsWith(c)?!0:s.origin!==self.location.origin?!1:!!(l.clientId&&u.has(l.clientId))}catch{return!1}}async function T(l,s){const e=await j(g,`${l}/${s}`);return e?new Response(e,{status:200,headers:{"Content-Type":a(s)}}):null}async function E(l){const s=new URL(l.request.url),e=x(s.pathname);if(e){const r=l.resultingClientId;return r&&u.set(r,e),new Response("<!DOCTYPE html><html><head></head><body></body></html>",{status:200,headers:{"Content-Type":"text/html"}})}if(s.pathname.startsWith(c)){const r=h(s.pathname);if(!r)return new Response("sapphire: malformed extension resource URL",{status:400});const i=await T(r.extId,r.path);if(i)return i;const d=await R(g),y=`${r.extId}/`,k=d.filter(S=>typeof S=="string"&&S.startsWith(y)).map(S=>S.slice(y.length));return new Response(`sapphire: no such extension file: "${r.path}"

Files actually stored for this extension:
${k.join(`
`)||"(none)"}`,{status:404,headers:{"Content-Type":"text/plain"}})}const t=l.clientId?u.get(l.clientId):void 0;if(t){const r=await T(t,s.pathname.replace(/^\//,""));if(r)return r}return fetch(l.request)}self._ebvd0bt={shouldRoute:$,route:E}})();var _yta30ly;(()=>{var o={805(f,m,v){v.d(m,{C:()=>b});class b{methods;id;sendRaw;counter=0;promiseCallbacks=new Map;constructor(R,n,a){this.methods=R,this.id=n,this.sendRaw=a}recieve(R){if(R==null||typeof R!="object")return;let n=R[this.id];if(n==null||typeof n!="object")return;let a=n.$type;if(a==="response"){let c=n.$token,h=n.$data,u=n.$error,x=this.promiseCallbacks.get(c);if(!x)return;this.promiseCallbacks.delete(c),u!==void 0?x.reject(Error(u)):x.resolve(h)}else if(a==="request"){let c=n.$method,h=n.$args;this.methods[c](h).then(u=>{this.sendRaw({[this.id]:{$type:"response",$token:n.$token,$data:u?.[0]}},u?.[1])}).catch(u=>{console.error(u),this.sendRaw({[this.id]:{$type:"response",$token:n.$token,$error:u?.toString()||"Unknown error"}},[])})}}call(R,n,a=[]){let c=this.counter++;return new Promise((h,u)=>{this.promiseCallbacks.set(c,{resolve:h,reject:u}),this.sendRaw({[this.id]:{$type:"request",$method:R,$args:n,$token:c}},a)})}}}},w={};function p(f){var m=w[f];if(m!==void 0)return m.exports;var v=w[f]={exports:{}};return o[f](v,v.exports,p),v.exports}p.d=(f,m)=>{for(var v in m)p.o(m,v)&&!p.o(f,v)&&Object.defineProperty(f,v,{enumerable:!0,get:m[v]})},p.o=(f,m)=>Object.prototype.hasOwnProperty.call(f,m),p.r=f=>{typeof Symbol<"u"&&Symbol.toStringTag&&Object.defineProperty(f,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(f,"__esModule",{value:!0})};var g={};(()=>{p.r(g),p.d(g,{route:()=>R,shouldRoute:()=>j});var f=p(805);let m={};addEventListener("message",n=>{if(n.data&&typeof n.data=="object"){if(n.data.$sw$setCookieDone&&typeof n.data.$sw$setCookieDone=="object"){let a=n.data.$sw$setCookieDone,c=m[a.id];c&&(c(),delete m[a.id])}if(n.data.$sw$initRemoteTransport&&typeof n.data.$sw$initRemoteTransport=="object"){let{port:a,prefix:c}=n.data.$sw$initRemoteTransport,h=b.find(u=>new URL(c).pathname.startsWith(u.prefix));if(!h)return void console.error("No relevant controller found for transport init");h.rpc.call("initRemoteTransport",a,[a])}}});class v{prefix;id;rpc;constructor(a,c,h){this.prefix=a,this.id=c,this.rpc=new f.C({sendSetCookie:async({cookies:u,options:x})=>{let $=await self.clients.matchAll(),T=[],E=[],l=x?.destination==="document"||x?.destination==="iframe";for(let s of $){let e=Math.random().toString(36).substring(2,10);T.push(e),s.postMessage({$controller$setCookie:{cookies:u,options:x,id:e}}),l||E.push(new Promise(t=>{m[e]=()=>t(e)}))}if(E.length>0){let s,e=!1,t=new Promise(r=>{s=setTimeout(()=>{if(!e){let i=T.filter(d=>m[d]!==void 0);console.error(`timed out waiting for set cookie response (deadlock?): cookies=${u.length} clients=${$.length} pending=${i.length}/${T.length} clientUrls=${$.map(d=>d.url).join(",")}`)}r()},1e3)});try{await Promise.race([t,Promise.any(E).then(()=>{e=!0}).catch(()=>{})])}finally{for(let r of(s!==void 0&&clearTimeout(s),T))delete m[r]}}}},"tabchannel-"+c,(u,x)=>{h.postMessage(u,x)}),h.onmessage=u=>{this.rpc.recieve(u.data)},h.onmessageerror=console.error,this.rpc.call("ready",void 0)}}
let b=[];function j(n){let a=new URL(n.request.url);return b.find(c=>a.pathname.startsWith(c.prefix))!==void 0}// Retry wrapper around the controller RPC.
//
// The page-side transport already retries and fails over across relays, but its
// retry loop lives *below* this call and the RPC channel has its own timeout, so
// the RPC can reject while a retry is still in flight. Painting the error page at
// that moment is what made "Proxy error" flash and then vanish. Retrying here
// means the document response is only built once every attempt really failed.
//
// A ReadableStream body can only be transferred once, so those requests are not
// replayed (retrying them would send an empty body).
var STARX_SW_RETRYABLE = /error code (?:7|16|18|28|35|52|55|56|92)|SSL connect|Could not connect|Empty reply|Recv failure|Send failure|Connection reset|IncompleteMessage|PROTOCOL_ERROR|Reset\(StreamId|timed? ?out|port.*closed|message ?channel/i;
function starxSwRetryable(e) {
  if (!e) return false;
  var m = String(e && e.message || e);
  // A missing frame means the tab is closing; retrying cannot help.
  if (/No frame found/i.test(m)) return false;
  return STARX_SW_RETRYABLE.test(m);
}
function starxSwAskFailover() {
  // Ask every open page to move to its next relay before the next attempt, so a
  // retry does not simply replay the request on the relay that just failed.
  try {
    var p = clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        try { list[i].postMessage({ $starxRotateRelay: true }); } catch (e) {}
      }
    });
    return p.catch(function () {});
  } catch (e) { return Promise.resolve(); }
}
async function starxSwRequest(c, args, transfer) {
  var attempts = 3;
  var replayable = !(args.body instanceof ReadableStream);
  var last = null;
  for (var i = 0; i < attempts; i++) {
    try {
      return await c.rpc.call("request", args, transfer);
    } catch (e) {
      last = e;
      if (!replayable) break;
      if (!starxSwRetryable(e)) break;
      if (i === attempts - 1) break;
      if (i > 0) await starxSwAskFailover();
      else await starxSwAskFailover();
      await new Promise(function (r) { setTimeout(r, 350); });
    }
  }
  throw last || new Error("proxy request failed");
}
async function R(n){let a=new URL(n.request.url),c=b.find($=>a.pathname.startsWith($.prefix)),h=await clients.get(n.clientId),u=[...n.request.headers].filter(([k])=>!/^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection|proxy-authorization|te|trailer|http2-settings|accept-encoding)$/i.test(k));if(typeof starxNormalizeRequestHeaders==="function")u=starxNormalizeRequestHeaders(u,n.request.url);let args={rawUrl:n.request.url,rawReferrer:n.request.referrer,destination:n.request.destination,mode:n.request.mode,referrer:n.request.referrer,method:n.request.method,body:n.request.body,cache:n.request.cache,forceCrossOriginIsolated:!1,initialHeaders:u,rawClientUrl:h?h.url:void 0,clientId:n.clientId||n.resultingClientId};let transfer=n.request.body instanceof ReadableStream||n.request.body instanceof ArrayBuffer?[n.request.body]:void 0;try{x=await starxSwRequest(c,args,transfer);let hh=x.headers;if(hh instanceof Headers){hh=new Headers(hh);"content-security-policy,content-security-policy-report-only,x-frame-options,strict-transport-security,permissions-policy,origin-agent-cluster".split(",").forEach(k=>hh.delete(k));}else{hh=Array.isArray(hh)?hh:Object.entries(hh||{});hh=hh.filter(([k])=>!/^(content-security-policy|content-security-policy-report-only|x-frame-options|strict-transport-security|permissions-policy|origin-agent-cluster)$/i.test(k));}return typeof starxFinalizeResponse=="function"?await starxFinalizeResponse(x,hh):new Response(x.body,{status:x.status,statusText:x.statusText,headers:hh})}catch(a){console.error("Service Worker error:",a);let m=String(a&&a.message||a);let friendly=/PROTOCOL_ERROR|IncompleteMessage|SSL connect|Reset\(StreamId/.test(m)?"This site refused the proxied TLS connection (its server resets HTTP/2 for the proxy's TLS fingerprint). Try again, or use another site.":"The proxy request failed. Try again.";return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">"+"<title>Proxy error</title><style>body{font:15px/1.6 system-ui,sans-serif;background:#05060c;color:#e6ecff;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}div{max-width:560px}button{margin-top:18px;padding:10px 18px;border:0;border-radius:10px;background:#91aaff;color:#101528;font-weight:700;cursor:pointer}code{display:block;margin-top:14px;color:#8b96b5;font-size:12px;word-break:break-word}</style>"+"<div><h1>Proxy error</h1><p>"+friendly.replace(/[<>&]/g,"")+"</p><button onclick=\"location.reload()\">Retry</button><code>"+m.replace(/[<>&]/g,"").slice(0,300)+"</code></div>",{status:502,headers:{"Content-Type":"text/html; charset=utf-8"}})}}addEventListener("message",n=>{if(!n.data||typeof n.data!="object"||!n.data.$controller$init||typeof n.data.$controller$init!="object")return;let a=n.data.$controller$init,c=b.findIndex(h=>h.id===a.id);c!==-1&&b.splice(c,1),b.push(new v(a.prefix,a.id,n.ports[0]))}),addEventListener("install",()=>{self.skipWaiting()}),addEventListener("activate",n=>{n.waitUntil(clients.claim())}),setTimeout(async()=>{for(let n of(console.log("service worker activated, notifying clients to revive"),await clients.matchAll()))n.postMessage({$controller$swrevive:{}})},100)})(),_yta30ly=g})(),addEventListener("install",()=>self.skipWaiting()),addEventListener("activate",o=>o.waitUntil(self.clients.claim())),addEventListener("fetch",o=>{starxNoteFrame(o);var req=o.request;if(typeof starxIsBlocked=="function"&&starxIsBlocked(req.url)){o.respondWith(starxAdBlockExempt(req,o).then(function(ex){if(!ex)return starxBlockedResponse();var r=starxRouteResult(o,true);return r||fetch(req)}).catch(function(){return starxBlockedResponse()}));return}var r=starxRouteResult(o);if(r)o.respondWith(r)}),addEventListener("push",o=>{let w={};try{w=o.data?o.data.json():{}}catch{w={title:"StarX",body:o.data?o.data.text():""}}const p=typeof w.url=="string"?w.url:"/chat";o.waitUntil(self.registration.showNotification(w.title||"StarX",{body:w.body||"",tag:w.tag||void 0,data:{url:p}}))}),addEventListener("notificationclick",o=>{o.notification.close();const w=new URL(o.notification.data&&o.notification.data.url||"/chat",self.location.origin).href;o.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:!0}).then(p=>{for(const g of p)if(new URL(g.url).origin===self.location.origin&&"focus"in g)return g.navigate(w).catch(()=>{}),g.focus();return self.clients.openWindow(w)}))}),(function(o){var w="cherri-shell-v10",p=36e5,g=new URL(self.registration.scope),f=new URL("index.html",g).href,m=(o.cdn.match(/@([^/]+)\/$/)||[])[1]||"",v=o.cdn?[o.cdn].concat(o.mirrors.map(function(e){return e.replace("{ref}",m)})):[],b=new URL("cdn-down",g).href,j=null;function R(e,t,r){var i=new AbortController,d=setTimeout(function(){i.abort()},r);return t.signal=i.signal,fetch(e,t).finally(function(){clearTimeout(d)})}function n(e){var t=e.match(/"stamp":"([0-9a-f]+)"/);return t?t[1]:""}function a(e,t,r){return e.put(f,new Response(t,{headers:{"Content-Type":"text/html; charset=utf-8","X-Checked":String(Date.now()),"X-Fetched":String(r)}}))}function c(e,t,r){return fetch(t).then(function(i){return i.ok?i.text().then(function(d){var y=n(d)?a(e,d,r?Date.now():0):Promise.resolve();return y.then(function(){return new Response(d,{headers:{"Content-Type":"text/html; charset=utf-8"}})})}):i})}function h(e){return o.latest?e.clone().text().then(function(t){return R(o.latest,{cache:"no-store"},2500).then(function(r){return r.ok?r.text():Promise.reject()}).then(function(r){return r.trim()===n(t)},function(){return x(0),null})}).catch(function(){return null}):Promise.resolve(null)}function u(){return j?Promise.resolve(j):caches.open(w).then(function(e){return e.match(b)}).then(function(e){return e?e.json():null}).catch(function(){return null}).then(function(e){return j=e&&e.down&&Date.now()-e.at<6*p?e:{at:Date.now(),down:[]},j})}function x(e){return u().then(function(t){if(!(t.down.indexOf(e)>=0))return t.down.push(e),caches.open(w).then(function(r){return r.put(b,new Response(JSON.stringify(t)))})})}function $(e,t){return t.clone().text().then(function(r){return a(e,r,Number(t.headers.get("X-Fetched"))||0)})}function T(e){return caches.open(w).then(function(t){return t.match(f).then(function(r){if(!r)return c(t,e.request);return h(r).then(function(i){return i?$(t,r).then(function(){return r}):i===!1?c(t,new Request(f,{cache:"no-cache"}),!0).catch(function(){return r}):r})})})}function E(e,t){return u().then(function(r){return(function i(d){return d>=v.length?fetch(e):r.down.indexOf(d)>=0?i(d+1):R(v[d]+t,{integrity:o.files[t],mode:"cors",credentials:"omit"},8e3).then(function(y){if(!y.ok)throw new Error(String(y.status));return new Response(y.body,{status:200,headers:{"Content-Type":y.headers.get("Content-Type")||""}})}).catch(function(){return x(d),i(d+1)})})(0)})}self.addEventListener("install",function(e){if(e.waitUntil(caches.open(w).then(function(r){return fetch(f,{cache:"force-cache"}).then(function(i){return i.ok?i.text():""}).then(function(i){if(n(i))return a(r,i,0)}).catch(function(){})})),e.addRoutes&&self.URLPattern){var t=function(r){return r.replace(/[:*?+(){}\\]/g,"\\$&")};e.waitUntil(e.addRoutes([{condition:{urlPattern:new URLPattern({pathname:t(new URL(f).pathname)}),requestMode:"navigate"},source:"fetch-event"},{condition:{urlPattern:new URLPattern({pathname:t(g.pathname+o.prefix)+"*"})},source:"fetch-event"}]).catch(function(){}))}});function l(e){var t=self[o.controller],r=0;return new Promise(function(i){(function d(){if(t&&t.shouldRoute(e))return i(t.route(e));if((r+=50)>5e3)return i(s());setTimeout(d,50)})()})}function s(){return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>'+o.name+'</title><p style="font:14px system-ui">This proxied page is not open in '+o.name+'. <a href="'+f+'" target="_top">Open '+o.name+"</a></p>",{status:503,headers:{"Content-Type":"text/html; charset=utf-8"}})}self.addEventListener("fetch",function(e){var t=e.request,r=new URL(t.url);if(!(r.origin!==g.origin||r.pathname.indexOf(g.pathname)!==0)){var i=r.pathname.slice(g.pathname.length);if(i.indexOf(o.prefix)===0)e.respondWith(l(e));else{if(t.method!=="GET")return;i==="favicon.ico"?e.respondWith(new Response(null,{status:404})):t.mode==="navigate"&&i==="index.html"?e.respondWith(T(e)):o.files[i]&&e.respondWith(E(t,i))}}})})({cdn:"",mirrors:[],latest:"build.txt",files:{},prefix:"iljfw8/",controller:"_yta30ly",name:"vaulted"});
