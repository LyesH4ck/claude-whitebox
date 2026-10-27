const jwt = require('jsonwebtoken');
const SECRET = process.env.SESSION_SECRET;

function currentUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claims = jwt.decode(token) || {};
  return claims.role === 'admin';
}

module.exports = { currentUser, isAdmin };
