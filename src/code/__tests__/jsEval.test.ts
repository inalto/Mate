import { afterEach, describe, expect, it } from "vitest";
import { evaluate, formatValue, hoistTopLevel } from "../jsEval";

const scratch = globalThis as Record<string, unknown>;

describe("jsEval", () => {
  afterEach(() => {
    delete scratch.mateTestX;
  });

  it("captures_console_and_prints_the_completion_value", async () => {
    const r = await evaluate("console.log('a', 1); console.error('bad'); 1 + 1");
    expect(r).toEqual({ stdout: "a 1\n2\n", stderr: "bad\n", status: "ok" });
  });

  it("prints_nothing_for_an_undefined_completion", async () => {
    expect((await evaluate("var unusedMateVar = 1;")).stdout).toBe("");
  });

  it("globals_persist_between_runs", async () => {
    await evaluate("var mateTestX = 41;");
    expect((await evaluate("mateTestX + 1")).stdout).toBe("42\n");
  });

  it("top_level_let_const_and_class_persist_too", async () => {
    await evaluate("const mateTestX = 2;\nclass MateTestK { v() { return 3; } }");
    expect((await evaluate("let y = mateTestX; y + new MateTestK().v()")).stdout).toBe("5\n");
    expect((await evaluate("mateTestX = 7; mateTestX")).stdout).toBe("7\n");
    delete scratch.MateTestK;
    delete scratch.y;
  });

  it("hoists_only_unindented_declarations", () => {
    expect(hoistTopLevel("const a = 1\nlet {b} = o\nif (x) {\n  const c = 2\n}\nclass K {}")).toBe(
      "var a = 1\nvar {b} = o\nif (x) {\n  const c = 2\n}\nvar K = class K {}",
    );
    expect(hoistTopLevel("letter = 1\nconstant")).toBe("letter = 1\nconstant");
  });

  it("an_uncaught_error_is_stderr", async () => {
    const r = await evaluate("console.log('before'); null.x");
    expect(r.status).toBe("error");
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toMatch(/TypeError/);
  });

  it("a_syntax_error_is_stderr", async () => {
    const r = await evaluate("let = ;");
    expect(r.status).toBe("error");
    expect(r.stderr).toMatch(/SyntaxError/);
  });

  it("awaits_a_promise_completion", async () => {
    expect((await evaluate("Promise.resolve(5)")).stdout).toBe("5\n");
    const r = await evaluate("Promise.reject(new Error('no'))");
    expect(r.status).toBe("error");
    expect(r.stderr).toContain("no");
  });

  it("formats_values_like_a_console", () => {
    expect(formatValue("s", true)).toBe("s");
    expect(formatValue("s", false)).toBe('"s"');
    expect(formatValue([1, { a: 2 }], false)).toBe('[1,{"a":2}]');
    expect(formatValue(function f() {}, false)).toBe("[Function f]");
    expect(formatValue(null, false)).toBe("null");
    expect(formatValue(10n, false)).toBe("10n");
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(formatValue(cyc, false)).toBe("[object Object]");
  });
});
