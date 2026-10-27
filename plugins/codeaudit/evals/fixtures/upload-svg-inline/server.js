const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const UPLOADS = path.join(__dirname, 'uploads');
const BLOCKED = ['.html', '.htm', '.js', '.php'];

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

app.post('/upload', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  const name = path.basename(String(req.query.name || ''));
  if (BLOCKED.includes(path.extname(name).toLowerCase())) return res.status(400).json({ error: 'type not allowed' });
  fs.writeFileSync(path.join(UPLOADS, name), req.body);
  res.json({ name });
});

app.get('/files/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const ext = path.extname(name).toLowerCase();
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.send(fs.readFileSync(path.join(UPLOADS, name)));
});

app.get('/downloads/:name', (req, res) => {
  const name = path.basename(req.params.name);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(fs.readFileSync(path.join(UPLOADS, name)));
});

module.exports = app;
