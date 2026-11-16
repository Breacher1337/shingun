/**
 * Egress-only secret scrubbing: transcripts on disk stay raw; text is
 * redacted only on its way to a provider. Secret literals come from .env
 * values (never stored, never logged).
 */
export function createScrubber(secretValues = [], extraPatterns = []) {
  const secrets = [...new Set(secretValues)].filter((s) => typeof s === 'string' && s.length >= 8);
  const patterns = extraPatterns.map((p) => new RegExp(p, 'gi'));
  return {
    scrub(text) {
      let t = String(text ?? '');
      for (const s of secrets) {
        t = t.split(s).join('[REDACTED]');
      }
      for (const re of patterns) {
        t = t.replace(re, '[REDACTED]');
      }
      return t;
    },
    scrubMessages(messages) {
      return (messages ?? []).map((m) => {
        if (typeof m.content === 'string') {
          return { ...m, content: this.scrub(m.content) };
        }
        return m;
      });
    }
  };
}
