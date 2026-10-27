# Plugin host

Loads report formatters and operator-installed plugins.

- `loadPlugins()` — loads every `.js` file from `PLUGIN_DIR` (default `/etc/app/plugins`) at startup
- `loadFormatter(req)` — loads the formatter named by the request's `format` parameter
