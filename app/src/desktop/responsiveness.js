'use strict';
// Native dialogs temporarily block Chromium's response checks. Only recover
// after a sustained hang outside a dialog, and cancel when the renderer recovers.
function responsivenessGuard(recover, { delayMs = 10000, graceMs = 2000 } = {}) {
  let timer, dialogDepth = 0, ignoreUntil = 0, disposed = false;
  function responsive() { clearTimeout(timer); timer = null; }
  return {
    responsive,
    unresponsive() {
      if (disposed || dialogDepth || Date.now() < ignoreUntil || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed && !dialogDepth && Date.now() >= ignoreUntil) recover();
      }, delayMs);
    },
    duringDialog(action) {
      dialogDepth++; responsive();
      try { return action(); }
      finally { dialogDepth--; ignoreUntil = Date.now() + graceMs; }
    },
    dispose() { disposed = true; responsive(); },
  };
}
module.exports = { responsivenessGuard };
