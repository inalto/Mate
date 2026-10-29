// Python error text for code blocks: Pyodide's tracebacks start with its own runner frames
// (the worker's runner and /lib/python3xx.zip/_pyodide/...); the user's block is the "<exec>"
// module. Those frames are dropped.

const USER_FRAME = /^ {2}File "<exec>", line \d+, in <module>$/m;

/** `message` with the frames before the user's `<module>` frame removed (unchanged when there is none). */
export function cleanTraceback(message: string): string {
  const at = USER_FRAME.exec(message)?.index ?? -1;
  if (at < 0 || !message.startsWith("Traceback")) return message.trimEnd();
  return `Traceback (most recent call last):\n${message.slice(at)}`.trimEnd();
}
