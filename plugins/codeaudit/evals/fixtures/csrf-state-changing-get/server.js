const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.urlencoded({ extended: false }));

const ACCOUNTS = { demo: { password: 'demo-password', email: 'demo@example.test', name: 'Demo' } };
const SESSIONS = new Map();
const ORIGIN = 'https://app.example.test';

app.post('/login', (req, res) => {
  const account = ACCOUNTS[req.body.username];
  if (!account || account.password !== req.body.password) return res.status(403).json({ error: 'login failed' });
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, { username: req.body.username, csrf: crypto.randomBytes(32).toString('hex') });
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/`);
  res.json({ ok: true });
});

function session(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('session='));
  return raw ? SESSIONS.get(raw.slice('session='.length)) : undefined;
}

app.get('/api/email', (req, res) => {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'login required' });
  ACCOUNTS[s.username].email = req.query.email;
  res.json({ email: ACCOUNTS[s.username].email });
});

app.post('/api/display-name', (req, res) => {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'login required' });
  if (req.headers.origin !== ORIGIN) return res.status(403).json({ error: 'bad origin' });
  if (req.body.csrf !== s.csrf) return res.status(403).json({ error: 'bad token' });
  ACCOUNTS[s.username].name = req.body.name;
  res.json({ name: ACCOUNTS[s.username].name });
});

module.exports = app;
