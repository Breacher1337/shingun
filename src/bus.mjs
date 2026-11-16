/** In-process event bus; subscribers are the CLI stream (and later, SSE). */
export function createBus() {
  const subs = new Set();
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    publish(event) {
      for (const fn of subs) {
        try { fn(event); } catch { /* a bad subscriber must not stall the swarm */ }
      }
    }
  };
}
