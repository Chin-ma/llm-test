// One JSON line per event, easy to grep in any host's log viewer.
export const log = (level, msg, extra = {}) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));
