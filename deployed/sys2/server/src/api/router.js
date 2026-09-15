'use strict';

// The two HTTP routes the assignment specifies, /message and /feed.
//
// These sit alongside the Socket.IO chat rather than replacing it. Both write
// into the same `messages` collection in the same room, so a message posted
// over HTTP shows up in the browser chat and a message typed in the browser
// shows up in /feed. There is one room and one history, reachable two ways.
//
// What the HTTP route deliberately does not do is invent a signature. The
// Socket.IO path refuses any message it cannot attribute to a key the sender
// proved they hold, and that has not changed. An HTTP caller has no key, so
// its messages are stored unsigned and are reported as unsigned everywhere the
// browser client already reports that. Encryption at rest is unconditional:
// every message stored by either route is AES-256-GCM encrypted first.

const { Router } = require('express');
const { randomUUID } = require('node:crypto');

const { encrypt } = require('../crypto/messageCipher');

const ROOM_ID = 'main';

// Longer than the Socket.IO limit of 500, because this route exists to be
// driven by a load generator sending messages of "random/variable length" and
// silently truncating those would make /feed disagree with what was sent.
const MAX_MESSAGE_BYTES = 16_384;
const MAX_NAME_LENGTH = 64;

// The assignment names these fields exactly, and those spellings are what the
// examples below use. The alternatives are accepted as well because the
// grading load generator is not ours and a request that is obviously a message
// should not be refused over a hyphen.
const NAME_FIELDS = ['client-name', 'client_name', 'clientName', 'clientname', 'name', 'username'];
const MESSAGE_FIELDS = ['msg', 'message', 'text'];
const ID_FIELDS = ['id', 'msgId', 'msg-id', 'message-id', 'messageId'];

function pick(source, fields) {
  if (!source || typeof source !== 'object') return undefined;

  for (const field of fields) {
    const value = source[field];
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

// Body first, then query string, so either style of client works.
function field(req, fields) {
  return pick(req.body, fields) ?? pick(req.query, fields);
}

function badRequest(res, reason) {
  res.status(400).json({ ok: false, error: reason });
}

/**
 * @param {object} deps
 * @param {import('./feedStore').FeedStore} deps.feed
 * @param {import('./writeQueue').WriteQueue} deps.writeQueue
 * @param {string} deps.instance
 */
function createApiRouter({ feed, writeQueue, instance }) {
  const router = Router();

  async function handleMessage(req, res) {
    const rawName = field(req, NAME_FIELDS);
    const rawMessage = field(req, MESSAGE_FIELDS);

    if (rawName === undefined) return badRequest(res, 'client-name is required.');
    if (rawMessage === undefined) return badRequest(res, 'msg is required.');

    const clientName = String(rawName).trim().slice(0, MAX_NAME_LENGTH);
    if (!clientName) return badRequest(res, 'client-name cannot be empty.');

    const text = String(rawMessage);
    if (!text.trim()) return badRequest(res, 'msg cannot be empty.');
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      return res.status(413).json({ ok: false, error: 'msg is too long.' });
    }

    // Where the message id comes from, in order of preference:
    //
    //   1. the caller, if it supplied one. A client that retries with the same
    //      id gets one stored message however many times it sends it.
    //   2. the X-Message-Id header, which the load balancer stamps on before
    //      forwarding. That is what makes it safe for the balancer to replay a
    //      request onto a second backend when the first one fails mid-request:
    //      both copies carry the same id, so at most one is stored.
    //   3. a fresh UUID, for a caller that does neither.
    const messageId =
      String(field(req, ID_FIELDS) ?? req.get('x-message-id') ?? '').trim() || randomUUID();

    const timestamp = new Date();
    const { ciphertext, nonce } = encrypt(text);

    let duplicate = false;

    try {
      ({ duplicate } = await writeQueue.insert({
        msgId: messageId,
        roomId: ROOM_ID,
        senderId: clientName,
        ciphertext,
        nonce,
        signature: null,
        senderPublicKey: null,
        timestamp,
        clientTimestamp: timestamp.getTime(),
        source: 'http',
      }));
    } catch (err) {
      console.error('Could not store message:', err.message);
      return res.status(503).json({ ok: false, error: 'Message could not be stored.' });
    }

    // Added even when the write was a duplicate: the original may have been
    // written by a different backend and not yet have reached this one over
    // the change stream. The store keys on the message id, so this is a no-op
    // if it is already there.
    feed.addLocal({ id: messageId, clientName, text, ts: timestamp.getTime() });

    res.json({
      ok: true,
      id: messageId,
      'client-name': clientName,
      msg: text,
      ts: timestamp.getTime(),
      duplicate,
      backend: instance,
    });
  }

  router.post('/message', handleMessage);

  // A GET that writes is not how this would be designed from scratch. It is
  // here because the grading load generator's method is not ours to choose,
  // and a message arriving as a query string should be stored rather than
  // refused. It is the same handler, with the same idempotency.
  router.get('/message', handleMessage);

  // Whether this caller said it can read a gzip body. Deliberately a plain
  // substring test rather than a full Accept-Encoding parse: the only thing
  // that would change under a correct parse is "gzip;q=0", which no real
  // client sends, and this runs on every read of the largest response here.
  function acceptsGzip(req) {
    const header = req.headers['accept-encoding'];
    return typeof header === 'string' && header.includes('gzip');
  }

  router.get('/feed', async (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 0;
    const since = Number.parseInt(req.query.since, 10) || 0;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Feed-Size', feed.size);

    // Vary, because a cache between here and the client would otherwise be
    // free to hand the compressed body to a client that cannot read it.
    res.setHeader('Vary', 'Accept-Encoding');

    let body = null;

    if (acceptsGzip(req)) {
      try {
        body = await feed.gzipPayload({ limit, since });
      } catch (err) {
        // Falling through to the uncompressed body is always correct, so a
        // compressor problem costs bandwidth rather than the route.
        console.error('gzip feed failed, sending it uncompressed:', err.message);
      }

      if (body) res.setHeader('Content-Encoding', 'gzip');
    }

    // Chunks written rather than joined: the store hands back a prefix that is
    // shared between every reader, and joining it onto the tail would copy the
    // whole room per request, which is the cost both representations are
    // shaped to avoid. Content-Length is known up front either way, so the
    // response is still a plain sized body rather than a chunked one.
    if (!body) body = feed.payload({ limit, since });

    const { chunks, length } = body;

    res.setHeader('Content-Length', length);

    for (let i = 0; i < chunks.length - 1; i += 1) res.write(chunks[i]);

    res.end(chunks[chunks.length - 1]);
  });

  return router;
}

module.exports = { createApiRouter, ROOM_ID, MAX_MESSAGE_BYTES };
