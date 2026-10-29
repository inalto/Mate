import { describe, expect, it } from "vitest";
import { cleanTraceback } from "../pyErrors";

describe("cleanTraceback", () => {
  it("drops_the_pyodide_runner_frames", () => {
    const raw =
      'Traceback (most recent call last):\n  File "<exec>", line 4, in _mate_run\n' +
      '  File "/lib/python314.zip/_pyodide/_base.py", line 619, in eval_code_async\n    await CodeRunner(\n' +
      '  File "<exec>", line 3, in <module>\n  File "<exec>", line 2, in f\nZeroDivisionError: division by zero\n';
    expect(cleanTraceback(raw)).toBe(
      'Traceback (most recent call last):\n  File "<exec>", line 3, in <module>\n  File "<exec>", line 2, in f\nZeroDivisionError: division by zero',
    );
  });

  it("keeps_other_messages", () => {
    expect(cleanTraceback("SyntaxError: bad\n")).toBe("SyntaxError: bad");
  });
});
