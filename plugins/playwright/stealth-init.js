// Injected before page scripts via @playwright/mcp `initScript` (Playwright addInitScript).
// Hides the most common JS-level automation tells. Authorized engagements only.
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
if (!window.chrome) { window.chrome = { runtime: {} }; }
