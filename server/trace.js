/** Per-request trace returned to the browser so its log panel can show what the server did. */
export function makeTrace() {
  const t0 = performance.now();
  const list = [];
  const add = (step, detail = {}) => list.push({ step, at: Math.round(performance.now() - t0), ...detail });
  /** Run fn, recording its duration and a summary of the result (or the error). */
  const time = async (step, fn, summarize = () => ({})) => {
    const s = performance.now();
    try {
      const r = await fn();
      list.push({ step, at: Math.round(s - t0), ms: Math.round(performance.now() - s), ...summarize(r) });
      return r;
    } catch (e) {
      list.push({ step, at: Math.round(s - t0), ms: Math.round(performance.now() - s), error: e.message });
      throw e;
    }
  };
  return { list, add, time, total: () => Math.round(performance.now() - t0) };
}
