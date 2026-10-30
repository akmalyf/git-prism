// CSS files are bundled as text (esbuild loader '.css': 'text') and injected by ui/styles.ts.
declare module '*.css' {
  const css: string;
  export default css;
}
