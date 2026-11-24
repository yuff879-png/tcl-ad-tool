'use strict';
const path = require('node:path');
const os = require('node:os');
function localUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
function externalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return url.hostname === 't.me' || url.hostname === 'tronscan.org' || url.hostname === 'www.tronscan.org'
      || (url.hostname === 'github.com' && /^\/yuff879-png\/tcl-ad-tool(?:\/|$)/.test(url.pathname));
  } catch { return false; }
}
function startupFile(value) {
  return typeof value === 'string' && path.dirname(path.resolve(value)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase()
    && /^tcl-startup-[a-f0-9-]+\.status$/i.test(path.basename(value));
}
function windowOptions(root, area, env = process.env) {
  return {
    title: 'TCL 广告投放工作台', icon: path.join(root, 'launcher/app.ico'),
    width: Math.min(area.width, Math.max(800, Number(env.TCL_WINDOW_WIDTH) || 1280)),
    height: Math.min(area.height, Math.max(600, Number(env.TCL_WINDOW_HEIGHT) || 820)),
    minWidth: 800, minHeight: 600, show: false, backgroundColor: '#f5f6fb', autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#716984', height: 38 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, spellcheck: false, backgroundThrottling: false, devTools: false },
  };
}
module.exports = { localUrl, externalUrl, startupFile, windowOptions };
