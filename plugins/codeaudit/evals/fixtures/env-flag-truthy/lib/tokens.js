const crypto = require('crypto');
const SECRET = process.env.GATEWAY_TOKEN_SECRET;

// Tokens are "<tenantId>.<hmac>" issued by the control plane.
function verifyBearer(header) {
  const token = (header || '').replace(/^Bearer /, '');
  const [tenantId, mac] = token.split('.');
  if (!tenantId || !mac || !SECRET) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(tenantId).digest('hex');
  if (expected.length !== mac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  return { tenantId };
}

module.exports = { verifyBearer };
