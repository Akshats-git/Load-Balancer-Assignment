const { Router } = require('express');

// Liveness. Deliberately trivial and free of database work: this is what the
// load balancer probes, and a health check that can be slowed down by the
// thing it is checking is no use for deciding whether to route to it.
function createHealthRouter(presence, instance = 'backend') {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      backend: instance,
      uptimeSeconds: Math.round(process.uptime()),
      onlineUsers: presence.count,
    });
  });

  return router;
}

// How busy this backend is. The load balancer polls this several times a
// second and turns the numbers into a routing score, so it answers from a
// snapshot that a timer keeps up to date rather than measuring on demand.
//
// It lives under /lb/ because the balancer answers every /lb/ path itself
// instead of forwarding it, which keeps this off the public surface.
function createLoadRouter({ metrics, feed, writeQueue }) {
  const router = Router();

  router.get('/lb/load', (req, res) => {
    res.json(metrics.report({ ...feed.stats(), ...writeQueue.stats() }));
  });

  return router;
}

module.exports = { createHealthRouter, createLoadRouter };
