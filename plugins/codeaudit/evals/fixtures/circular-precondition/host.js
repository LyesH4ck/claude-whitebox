const path = require('path');
const fs = require('fs');

const PLUGIN_DIR = process.env.PLUGIN_DIR || '/etc/app/plugins';

// Loaded at startup from the operator-managed plugin directory.
function loadPlugins() {
  const loaded = [];
  for (const file of fs.readdirSync(PLUGIN_DIR)) {
    if (file.endsWith('.js')) loaded.push(require(path.join(PLUGIN_DIR, file)));
  }
  return loaded;
}

// Resolves the formatter requested by the caller.
function loadFormatter(req) {
  const name = req.query.format;
  return require(path.join(__dirname, 'formatters', name));
}

module.exports = { loadPlugins, loadFormatter };
