'use strict';
// "Sleep mode": every minute, check the folder and quietly tidy whatever has settled.

function createWatcher({ getSettings, tidy, onResult, onError, intervalMs = 60000 }) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    const s = getSettings();
    if (!s.autoMode || !s.folder) return;
    running = true;
    try {
      const result = await tidy({ auto: true });
      if (result && result.moved > 0) onResult && onResult(result);
    } catch (e) {
      onError && onError(e);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      setTimeout(tick, 3000);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick,
    isRunning: () => running,
  };
}

module.exports = { createWatcher };
