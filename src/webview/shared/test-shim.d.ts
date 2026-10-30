// Minimal typings for node:test / node:assert used by pure *.test.ts files under src/webview (the webview
// tsconfig has no node types). Tests are bundled for node by `node scripts/build.mjs --test`.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export const it: typeof test;
}
declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string): Promise<void>;
    match(value: string, re: RegExp, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
