// Pure time formatting, kept apart from the dictation store so renderers can use it.

/** `ms` as m:ss (the recording's elapsed time on the button, the duration on a recording marker). */
export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
