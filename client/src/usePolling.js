import { useEffect, useRef, useState, useCallback } from 'react';

/** Runs `fn` now and every `ms`. Keeps the last good data and exposes an error for the UI. */
export function usePolling(fn, ms, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async () => {
    try { setData(await fnRef.current()); setError(null); }
    catch (e) { setError(e); }
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => { if (!stop) await refresh(); };
    tick();
    const id = setInterval(tick, ms);
    return () => { stop = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refresh, ...deps]);

  return { data, error, refresh };
}
