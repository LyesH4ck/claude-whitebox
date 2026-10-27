const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyBearer } = require('./lib/tokens');
const { Invoices } = require('./lib/invoices');

const app = express();

// Developers can turn the token check off locally; production must never set this.
function requireToken(req, res, next) {
  if (process.env.DISABLE_AUTH) return next();
  const principal = verifyBearer(req.headers.authorization);
  if (!principal) return res.status(401).json({ error: 'unauthorized' });
  req.principal = principal;
  return next();
}

// Rate limiting can be switched off for load tests.
const rateLimitOff = process.env.RATE_LIMIT_OFF === 'true';
const limiter = rateLimit({ windowMs: 60_000, limit: 120 });
function maybeLimit(req, res, next) {
  if (rateLimitOff) return next();
  return limiter(req, res, next);
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/invoices/:id', requireToken, maybeLimit, async (req, res) => {
  const invoice = await Invoices.find(req.params.id, req.principal.tenantId);
  if (!invoice) return res.status(404).end();
  return res.json(invoice);
});

app.post('/invoices/:id/void', requireToken, maybeLimit, async (req, res) => {
  await Invoices.void(req.params.id, req.principal.tenantId);
  return res.status(204).end();
});

module.exports = app;
