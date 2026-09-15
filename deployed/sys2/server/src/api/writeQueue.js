'use strict';

// Groups concurrent inserts into one bulk write.
//
// The problem this solves: under load the chat server spends most of its time
// waiting on round trips to MongoDB, one per message. Those round trips are
// almost entirely latency rather than work, so a hundred messages arriving at
// once cost a hundred waits that could have been one.
//
// The queue collects everything that arrives while it is already waiting on
// the database and sends it as a single unordered bulkWrite. That is the whole
// trick, and it needs no timer: a batch is exactly the messages that turned up
// during the previous batch's round trip, so the batch size follows the
// arrival rate on its own. Idle, that is one document and behaves exactly like
// a plain insert; under load the batch grows to whatever arrived during the
// last round trip, and MongoDB sees that many fewer commands.
//
// Deliberately no artificial delay. Waiting a fixed two milliseconds to fill a
// batch would buy the same batching and charge two milliseconds to every
// message sent to an idle server.
//
// The important property is that this does not weaken durability. Each caller
// gets a promise that settles only after the batch its document was in has
// been acknowledged by the database, so a 200 response still means "written",
// not "queued". Nothing is buffered across a crash.
//
// Duplicate keys are a normal outcome, not an error. Two copies of the same
// message id, whether from a client retry or from the load balancer replaying
// a request onto a second backend, must end up as one row. MongoDB rejects the
// second one with error 11000 and the caller is told it was a duplicate.

const DUPLICATE_KEY = 11000;

class WriteQueue {
  /**
   * @param {import('mongodb').Collection} collection
   * @param {{ maxBatch?: number }} [options]
   */
  constructor(collection, { maxBatch = 1000, maxInFlight = 8 } = {}) {
    this.collection = collection;
    this.maxBatch = maxBatch;

    // How many bulk writes may be waiting on the database at once. This is the
    // dial that trades batch size against queueing: a low number forces bigger
    // batches and fewer commands, but makes a burst wait behind the batches
    // already in flight, which shows up in the tail of the response times. The
    // value here was chosen by measurement, see the report.
    this.maxInFlight = maxInFlight;
    this.inFlight = 0;

    this.pending = [];
    this.scheduled = false;

    // Reported to the load balancer, which treats a growing queue as load.
    this.depth = 0;
    this.batches = 0;
    this.documents = 0;
    this.duplicates = 0;
  }

  /**
   * Queues one document and resolves once it is safely in the database.
   *
   * @param {object} document
   * @returns {Promise<{ duplicate: boolean }>}
   */
  insert(document) {
    return new Promise((resolve, reject) => {
      this.pending.push({ document, resolve, reject });
      this.depth = this.pending.length;

      // A full batch goes immediately. Otherwise the flush is scheduled for the
      // end of this turn of the event loop, which picks up every request that
      // has already been parsed and is waiting. If the database is busy with
      // as many batches as it is allowed, that flush finds nothing to do and
      // the documents stay here until a slot frees up, which is what makes the
      // batches grow under load.
      if (this.pending.length >= this.maxBatch) {
        this.flush();
      } else if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => this.flush());
      }
    });
  }

  async flush() {
    this.scheduled = false;

    if (this.pending.length === 0) return;
    if (this.inFlight >= this.maxInFlight) return;

    let batch;
    if (this.pending.length > this.maxBatch) {
      batch = this.pending.splice(0, this.maxBatch);
    } else {
      batch = this.pending;
      this.pending = [];
    }

    this.depth = this.pending.length;

    this.inFlight += 1;

    const operations = batch.map((item) => ({ insertOne: { document: item.document } }));

    let writeErrors = [];

    try {
      await this.collection.bulkWrite(operations, { ordered: false });
    } catch (err) {
      writeErrors = normaliseWriteErrors(err);

      // No per-document errors means the whole write failed: the database is
      // unreachable, or the connection dropped. Everyone in the batch hears
      // about it.
      if (writeErrors.length === 0) {
        this.inFlight -= 1;
        for (const item of batch) item.reject(err);
        this.drain();
        return;
      }
    }

    this.inFlight -= 1;

    const failedAt = new Map();
    for (const error of writeErrors) failedAt.set(error.index, error);

    this.batches += 1;
    this.documents += batch.length;

    batch.forEach((item, index) => {
      const error = failedAt.get(index);

      if (!error) {
        item.resolve({ duplicate: false });
        return;
      }

      if (error.code === DUPLICATE_KEY) {
        this.duplicates += 1;
        item.resolve({ duplicate: true });
        return;
      }

      item.reject(new Error(error.errmsg || 'write failed'));
    });

    this.drain();
  }

  // A slot has freed up, so send whatever built up while it was busy.
  drain() {
    if (this.pending.length === 0 || this.scheduled) return;
    if (this.inFlight >= this.maxInFlight) return;

    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  stats() {
    return {
      queueDepth: this.depth,
      batches: this.batches,
      documentsWritten: this.documents,
      duplicatesRejected: this.duplicates,
      averageBatch: this.batches ? Math.round((this.documents / this.batches) * 10) / 10 : 0,
      writesInFlight: this.inFlight,
    };
  }
}

// The driver reports per-document failures in slightly different shapes
// depending on how the write failed, so flatten them into one list of
// { index, code, errmsg }.
function normaliseWriteErrors(err) {
  const raw = err && err.writeErrors;
  if (!raw) return [];

  const list = Array.isArray(raw) ? raw : [raw];

  return list.map((entry) => {
    const inner = entry.err || entry;
    return {
      index: inner.index,
      code: inner.code,
      errmsg: inner.errmsg,
    };
  });
}

module.exports = { WriteQueue };
