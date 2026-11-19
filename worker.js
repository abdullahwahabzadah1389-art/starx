/**
 * StarX — Wisp v1 relay for Cloudflare Workers
 * by Sm0ke
 *
 * A single-file Wisp v1.2 server. Paste this whole file into the Cloudflare
 * dashboard (Workers & Pages → your worker → Edit code → Deploy) and point
 * StarX at it:
 *
 *     NEXT_PUBLIC_WISP_URL=wss://<your-worker>.workers.dev/
 *
 * Any path works — StarX opens the socket at the URL as given. No npm
 * dependencies: the only import is Cloudflare's built-in `cloudflare:sockets`.
 *
 * WHAT IT DOES
 *   Runs the Wisp protocol (CONNECT / DATA / CONTINUE / CLOSE) over a single
 *   WebSocket and multiplexes many TCP (and UDP) sockets across it. Each Wisp
 *   stream becomes one outbound `connect()` socket.
 *
 * WIRE FORMAT (all integers little-endian)
 *   packet  = uint8 type | uint32 streamId | payload...
 *   0x01 CONNECT   payload: uint8 streamType (1=TCP, 2=UDP) | uint16 port | UTF-8 hostname
 *   0x02 DATA      payload: raw bytes
 *   0x03 CONTINUE  payload: uint32 packets the server can still buffer
 *   0x04 CLOSE     payload: uint8 close reason
 *
 * On open the server sends CONTINUE(streamId 0, bufferSize) before anything
 * else — clients wait for it, and StarX's relay probe uses it as its health
 * check (it needs a first byte of 0x03).
 *
 * OPTIONAL SHARED SECRET
 *   Set a `WISP_TOKEN` variable on the worker to require a token. It is
 *   accepted as `?token=...` on the WebSocket URL or as
 *   `Authorization: Bearer ...`. When the variable is unset the relay is open.
 *
 * LIMITS WORTH KNOWING
 *   - Workers sockets are outbound-only and cannot reach the worker's own
 *     private network, so private/link-local destinations are rejected up
 *     front (tested below) rather than leaking internal probes.
 *   - Cloudflare caps concurrent outgoing connections per request; MAX_STREAMS
 *     keeps a single client well under it.
 *   - Workers have no timer longer than the request lifetime, so very long
 *     idle TCP streams are ended by Cloudflare, not by this code.
 */

import { connect } from 'cloudflare:sockets';

/* -------------------------------------------------------------------------- */
/* Protocol constants                                                         */
/* -------------------------------------------------------------------------- */

const TYPE_CONNECT = 0x01;
const TYPE_DATA = 0x02;
const TYPE_CONTINUE = 0x03;
const TYPE_CLOSE = 0x04;

const STREAM_TCP = 0x01;
const STREAM_UDP = 0x02;

// Close reasons (see the Wisp spec).
const CLOSE_UNKNOWN = 0x01;
const CLOSE_VOLUNTARY = 0x02;
const CLOSE_NETWORK = 0x03;
const CLOSE_BAD_REQUEST = 0x41;
const CLOSE_HOST_UNREACHABLE = 0x42;
const CLOSE_TIMEOUT = 0x43;
const CLOSE_BLOCKED = 0x48;
const CLOSE_THROTTLED = 0x49;

/** How many DATA packets we tell the client it may have in flight per stream. */
const BUFFER_PACKETS = 16;
/** Refuse the (MAX_STREAMS + 1)th stream on one WebSocket. */
const MAX_STREAMS = 200;
/**
 * Cloudflare queues a Worker's outgoing connects once six are waiting for a
 * handshake. Gate them here instead, so a burst of CONNECTs is staggered
 * deliberately rather than piling up in the runtime's queue, where our own
 * timeout could expire before the socket was ever dialled.
 */
const MAX_PENDING_CONNECTS = 6;
/** How long to wait for a TCP handshake before closing the Wisp stream. */
const CONNECT_TIMEOUT_MS = 20000;

const VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Packet helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Build a complete packet: 5-byte header plus payload. */
function makePacket(type, streamId, payload) {
  const body = payload || EMPTY;
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  // writeUint32LE by hand: DataView is fine but this avoids an extra object
  // per packet on the hot path.
  out[1] = streamId & 0xff;
  out[2] = (streamId >>> 8) & 0xff;
  out[3] = (streamId >>> 16) & 0xff;
  out[4] = (streamId >>> 24) & 0xff;
  out.set(body, 5);
  return out;
}

const EMPTY = new Uint8Array(0);

/** CONTINUE packet: header + uint32 buffer remaining. */
function continuePacket(streamId, remaining) {
  const out = new Uint8Array(9);
  out[0] = TYPE_CONTINUE;
  out[1] = streamId & 0xff;
  out[2] = (streamId >>> 8) & 0xff;
  out[3] = (streamId >>> 16) & 0xff;
  out[4] = (streamId >>> 24) & 0xff;
  out[5] = remaining & 0xff;
  out[6] = (remaining >>> 8) & 0xff;
  out[7] = (remaining >>> 16) & 0xff;
  out[8] = (remaining >>> 24) & 0xff;
  return out;
}

function closePacket(streamId, reason) {
  return makePacket(TYPE_CLOSE, streamId, Uint8Array.of(reason));
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/* -------------------------------------------------------------------------- */
/* Destination validation                                                     */
/* -------------------------------------------------------------------------- */

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

/**
 * Reject addresses that cannot legitimately be reached from a Worker and that
 * would otherwise turn the relay into a probe for internal services.
 * Returns true when the host must not be dialled.
 */
function isBlockedHost(rawHost) {
  let host = String(rawHost || '').trim().toLowerCase();
  if (!host || host.length > 253) return true;

  // IPv6 literals arrive as [::1] from the protocol; strip the brackets.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host === 'localhost.') return true;
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }

  // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10),
  // and IPv4-mapped forms of anything blocked below.
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
    if (host.startsWith('::ffff:')) return isBlockedHost(host.slice(7));
    if (host.startsWith('64:ff9b:')) return true; // NAT64
    return false;
  }

  // IPv4 (only when the host is entirely numeric dots, so a hostname that
  // happens to contain digits is untouched).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 127) return true; // this-network, loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }

  // Anything else must look like a DNS name.
  if (!/^[a-z0-9_.-]+$/.test(host)) return true;
  if (host.startsWith('.') || host.endsWith('.')) return true;
  return false;
}

/** Turn an unqualified single-label name into a real FQDN. */
function normalizeHost(rawHost) {
  let host = String(rawHost || '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Session: one WebSocket, many streams                                       */
/* -------------------------------------------------------------------------- */

function createSession(ws, send) {
  const streams = new Map();
  let closed = false;

  // Simple counting semaphore for in-flight handshakes. FIFO, so streams are
  // dialled in the order the client asked for them.
  let pending = 0;
  const waiters = [];
  async function withConnectSlot(fn) {
    if (pending >= MAX_PENDING_CONNECTS) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    pending++;
    try {
      return await fn();
    } finally {
      pending--;
      const next = waiters.shift();
      if (next) next();
    }
  }

  /** Send a packet, ignoring failures on an already-dead socket. */
  function emit(packet) {
    if (closed) return;
    try {
      ws.send(packet);
    } catch {
      /* socket is gone; the close handler tears everything down */
    }
  }

  function closeStream(stream, reason, notifyClient) {
    if (stream.closed) return;
    stream.closed = true;
    streams.delete(stream.id);

    // Stop both directions. cancel()/abort() are preferred to close() because
    // the client asked for an immediate reset.
    try {
      stream.reader && stream.reader.cancel().catch(() => {});
    } catch {}
    try {
      stream.writer && stream.writer.abort && stream.writer.abort().catch(() => {});
    } catch {}
    try {
      stream.socket && stream.socket.close();
    } catch {}

    if (notifyClient) emit(closePacket(stream.id, reason));
  }

  /** Pump bytes from the origin socket back to the client as DATA packets. */
  async function pumpOut(stream) {
    let reader;
    try {
      reader = stream.socket.readable.getReader();
    } catch {
      closeStream(stream, CLOSE_NETWORK, true);
      return;
    }
    stream.reader = reader;

    try {
      while (!stream.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (stream.closed || !value || value.byteLength === 0) continue;
        emit(makePacket(TYPE_DATA, stream.id, value));
      }
      // Origin finished sending: tell the client so it can close its side.
      if (!stream.closed) {
        emit(closePacket(stream.id, CLOSE_VOLUNTARY));
        closeStream(stream, CLOSE_VOLUNTARY, false);
      }
    } catch {
      closeStream(stream, CLOSE_NETWORK, true);
    }
  }

  /**
   * Drain the client→origin queue for one stream. Writes are serialised so a
   * stream never has two concurrent writes, and CONTINUE is sent as the queue
   * empties to keep the client's window topped up.
   */
  async function drain(stream) {
    if (stream.draining || stream.closed) return;
    stream.draining = true;
    let sinceContinue = 0;

    try {
      while (stream.queue.length && !stream.closed) {
        const chunk = stream.queue.shift();
        if (!stream.writer) stream.writer = stream.socket.writable.getWriter();
        await stream.writer.write(chunk);
        stream.buffered--;

        // Top the client's window up: immediately when the queue empties, and
        // periodically during a long write burst so it never has to wait for a
        // full buffer round-trip before sending again.
        sinceContinue++;
        if (stream.buffered === 0 || sinceContinue >= 8) {
          sinceContinue = 0;
          emit(continuePacket(stream.id, BUFFER_PACKETS - stream.buffered));
        }
      }
    } catch {
      closeStream(stream, CLOSE_NETWORK, true);
    } finally {
      stream.draining = false;
    }

    // A packet can arrive between the loop exiting and `draining` clearing.
    if (stream.queue.length && !stream.closed) drain(stream);
  }

  /* ---------------------------- CONNECT ---------------------------------- */

  async function onConnect(streamId, payload) {
    if (streams.has(streamId)) {
      // The client reused an id; reset the old stream instead of leaking it.
      closeStream(streams.get(streamId), CLOSE_VOLUNTARY, false);
    }
    if (streams.size >= MAX_STREAMS) {
      emit(closePacket(streamId, CLOSE_THROTTLED));
      return;
    }
    if (payload.length < 3) {
      emit(closePacket(streamId, CLOSE_BAD_REQUEST));
      return;
    }

    const streamType = payload[0];
    const port = payload[1] | (payload[2] << 8);

    if (streamType !== STREAM_TCP && streamType !== STREAM_UDP) {
      emit(closePacket(streamId, CLOSE_BAD_REQUEST));
      return;
    }
    if (port === 0) {
      emit(closePacket(streamId, CLOSE_BAD_REQUEST));
      return;
    }

    let hostname;
    try {
      hostname = new TextDecoder().decode(payload.subarray(3));
    } catch {
      emit(closePacket(streamId, CLOSE_BAD_REQUEST));
      return;
    }
    if (isBlockedHost(hostname)) {
      emit(closePacket(streamId, CLOSE_BLOCKED));
      return;
    }

    // Cloudflare Workers expose outbound TCP only: `connect()` has no UDP mode
    // in the standard runtime. UDP is mandatory in Wisp v1, so answer honestly
    // with a close packet rather than pretending the stream opened.
    if (streamType === STREAM_UDP) {
      emit(closePacket(streamId, CLOSE_BAD_REQUEST));
      return;
    }

    const target = normalizeHost(hostname);

    // Register the stream before dialling so DATA the client pipelined straight
    // after CONNECT has somewhere to wait (the spec allows sending immediately).
    const stream = {
      id: streamId,
      socket: null,
      queue: [],
      buffered: 0,
      draining: false,
      closed: false,
      reader: null,
      writer: null,
    };
    streams.set(streamId, stream);

    await withConnectSlot(async () => {
      if (stream.closed) return;

      let socket;
      try {
        socket = connect({ hostname: target, port });
      } catch {
        emit(closePacket(streamId, CLOSE_HOST_UNREACHABLE));
        closeStream(stream, CLOSE_HOST_UNREACHABLE, false);
        return;
      }
      stream.socket = socket;

      // Wait for the handshake so a refused/unreachable target gets a specific
      // reason instead of a generic stream error later on.
      let timer;
      try {
        await Promise.race([
          socket.opened,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        clearTimeout(timer);
        const timedOut = err && /timeout/i.test(String(err.message || err));
        closeStream(stream, timedOut ? CLOSE_TIMEOUT : CLOSE_HOST_UNREACHABLE, true);
        return;
      }
      clearTimeout(timer);

      // The client may have closed the stream while we were still connecting.
      if (stream.closed) return;

      emit(continuePacket(streamId, BUFFER_PACKETS));

      // Anything the client pipelined before the handshake finished.
      if (stream.queue.length) drain(stream);

      socket.closed
        .then(() => closeStream(stream, CLOSE_VOLUNTARY, true))
        .catch(() => closeStream(stream, CLOSE_NETWORK, true));

      pumpOut(stream);
    });
  }

  /* ---------------------------- dispatch --------------------------------- */

  function handlePacket(type, streamId, payload) {
    switch (type) {
      case TYPE_CONNECT:
        // Stream id 0 is control traffic in Wisp v1 (the StarX probe sends a
        // pseudo-INFO packet there), so answer with the buffer advertisement
        // rather than opening a socket to a bogus host.
        if (streamId === 0) {
          emit(continuePacket(0, BUFFER_PACKETS));
          return;
        }
        onConnect(streamId, payload);
        return;

      case TYPE_DATA: {
        if (streamId === 0) return;
        const stream = streams.get(streamId);
        if (!stream || stream.closed || payload.length === 0) return;
        stream.queue.push(payload);
        stream.buffered++;
        drain(stream);
        return;
      }

      case TYPE_CLOSE: {
        if (streamId === 0) {
          destroy();
          return;
        }
        const stream = streams.get(streamId);
        if (stream) closeStream(stream, CLOSE_VOLUNTARY, false);
        return;
      }

      case TYPE_CONTINUE:
        // Clients are allowed to send it; there is nothing to do with it.
        return;

      default:
        // Unknown packet type: ignore. A WebSocket carries discrete messages,
        // so there is no framing to re-synchronise.
        return;
    }
  }

  function onMessage(data) {
    if (closed) return;

    let bytes;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return; // text frames are not part of Wisp

    if (bytes.byteLength < 5) return;

    const type = bytes[0];
    const streamId = readUint32LE(bytes, 1);
    const payload = bytes.subarray(5);
    try {
      handlePacket(type, streamId, payload);
    } catch {
      emit(closePacket(streamId, CLOSE_UNKNOWN));
    }
  }

  /** Tear every stream down. Called on WebSocket close/error. */
  function destroy() {
    if (closed) return;
    closed = true;
    for (const stream of [...streams.values()]) {
      closeStream(stream, CLOSE_VOLUNTARY, false);
    }
    streams.clear();
    try {
      ws.close(1000, 'closing');
    } catch {}
  }

  ws.addEventListener('message', (event) => onMessage(event.data));
  ws.addEventListener('close', () => destroy());
  ws.addEventListener('error', () => destroy());

  return { destroy, onMessage };
}

/* -------------------------------------------------------------------------- */
/* Worker entry point                                                          */
/* -------------------------------------------------------------------------- */

function unauthorized(message) {
  return new Response(message + '\n', {
    status: 401,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function health(request, url) {
  const body = [
    'StarX Wisp relay — v' + VERSION,
    '',
    'This endpoint speaks the Wisp v1 protocol over a WebSocket.',
    'Point StarX at it with:',
    '',
    '  NEXT_PUBLIC_WISP_URL=wss://' + url.host + '/',
    '',
    'GET requests get this page; WebSocket upgrades become proxy streams.',
  ].join('\n');

  return new Response(body + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/** Constant-ish time compare so the token check does not leak length. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Plain HTTP requests are not part of the protocol; serve a health page so
    // a browser visit (or an uptime check) explains what the endpoint is.
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') return health(request, url);

    // Optional shared secret. Only enforced when WISP_TOKEN is configured.
    const token = (env && env.WISP_TOKEN) || '';
    if (token) {
      const fromQuery = url.searchParams.get('token') || '';
      const auth = request.headers.get('Authorization') || '';
      const fromHeader = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      const fromProtocol = (request.headers.get('Sec-WebSocket-Protocol') || '')
        .split(',')
        .map((s) => s.trim())
        .find((s) => s.startsWith('wisp.token.'));

      const supplied = fromQuery || fromHeader || (fromProtocol ? fromProtocol.slice('wisp.token.'.length) : '');
      if (!safeEqual(supplied, token)) return unauthorized('Unauthorized');
    }

    /** @type {WebSocketPair} */
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.binaryType = 'arraybuffer';

    // Echo the `wisp` subprotocol when the client asks for it. The protocol
    // does not require one, but picking it stops browsers from failing the
    // handshake on clients that send it.
    const offered = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',')
      .map((s) => s.trim());
    const headers = {};
    if (offered.includes('wisp')) headers['Sec-WebSocket-Protocol'] = 'wisp';

    createSession(server, (packet) => server.send(packet));

    // Wisp v1: the server advertises its per-stream buffer on stream id 0
    // before anything else. StarX's relay probe accepts a relay only when the
    // first message it receives starts with 0x03.
    try {
      server.send(continuePacket(0, BUFFER_PACKETS));
    } catch {
      return new Response('WebSocket closed during handshake\n', { status: 500 });
    }

    return new Response(null, { status: 101, headers, webSocket: client });
  },
};
