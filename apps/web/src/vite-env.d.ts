/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// mjml-browser ships no published types. easy-email-editor declares them in
// its lib/typings/mjml-browser.d.ts but our tsconfig only includes ./src, so
// we inline a minimal shim covering the function signature we actually use.
declare module 'mjml-browser' {
  interface MjmlOptions {
    beautify?: boolean;
    minify?: boolean;
    keepComments?: boolean;
    validationLevel?: 'strict' | 'soft' | 'skip';
  }
  const mjml2html: (
    mjml: string,
    options?: MjmlOptions,
  ) => { html: string; errors: unknown[] };
  export default mjml2html;
}
