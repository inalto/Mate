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

  it("hoists_only_top_level_declarations", () => {
    expect(hoistTopLevel("const a = 1\nlet {b} = o\nif (x) {\n  const c = 2\n}\nclass K {}")).toBe(
      "var a = 1\nvar {b} = o\nif (x) {\n  const c = 2\n}\nvar K = class K {}",
    );
    expect(hoistTopLevel("letter = 1\nconstant")).toBe("letter = 1\nconstant");
    expect(hoistTopLevel("const a = 1; let b = 2; class C {}")).toBe("var a = 1; var b = 2; var C = class C {}");
    // Unindented declarations inside blocks keep their block scope.
    expect(hoistTopLevel("for (let i = 0; i < 3; i++) {\nconst v = i\n}")).toBe("for (let i = 0; i < 3; i++) {\nconst v = i\n}");
    expect(hoistTopLevel("function f() {\nlet y = 1\nreturn y\n}")).toBe("function f() {\nlet y = 1\nreturn y\n}");
    expect(hoistTopLevel("obj.\nlet = 1")).toBe("obj.\nlet = 1");
  });

  it("leaves_strings_comments_templates_and_regexes_alone", () => {
    const src = [
      "const t = `line one",
      "let x = 1",
      "const ${'y'} ${`",
      "class Inner`} z`",
      "// const c = 1",
      "/* let d = 2",
      "class E */",
      "const s = 'let q = 1' + \"const r\"",
      "const re = /let \\/x/g",
      "let w = 4",
    ].join("\n");
    const expected = [
      "var t = `line one",
      "let x = 1",
      "const ${'y'} ${`",
      "class Inner`} z`",
      "// const c = 1",
      "/* let d = 2",
      "class E */",
      "var s = 'let q = 1' + \"const r\"",
      "var re = /let \\/x/g",
      "var w = 4",
    ].join("\n");
    expect(hoistTopLevel(src)).toBe(expected);
  });

  it("a_template_literal_line_starting_with_let_is_kept", async () => {
    const r = await evaluate("const mateTestX = `a\nlet x = 1\nb`;\nmateTestX.split('\\n')[1]");
    expect(r).toEqual({ stdout: '"let x = 1"\n', stderr: "", status: "ok" });
  });

  it("closures_over_a_loop_body_const_get_their_own_binding", async () => {
    const r = await evaluate("var mateTestX = [];\nfor (let i = 0; i < 3; i++) {\nconst v = i\nmateTestX.push(() => v)\n}\nmateTestX.map((f) => f()).join(',')");
    expect(r.stdout).toBe('"0,1,2"\n');
  });

  it("caps_a_runaway_console_loop", async () => {
    const r = await evaluate("for (let i = 0; i < 5000; i++) console.log('line ' + i)", 1000);
    expect(r.stdout.startsWith("… (truncated)\n")).toBe(true);
    expect(r.stdout.length).toBeLessThan(1100);
    expect(r.stdout.endsWith("line 4999\n")).toBe(true);
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
