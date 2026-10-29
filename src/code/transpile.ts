// TypeScript → JavaScript for code blocks: types stripped by sucrase (no type checking), loaded on
// the first TypeScript run so the editor bundle does not carry it.
let sucrase: Promise<typeof import("sucrase")> | null = null;

/** `code` without its TypeScript syntax; throws a SyntaxError-like Error on invalid code. */
export async function transpileTs(code: string): Promise<string> {
  sucrase ??= import("sucrase");
  sucrase.catch(() => (sucrase = null));
  const { transform } = await sucrase;
  return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
}
