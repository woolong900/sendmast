// eslint-disable-next-line @typescript-eslint/no-require-imports
const mjml2html: (mjml: string, opts?: Record<string, unknown>) => { html: string; errors: Array<{ message: string }> } = require('mjml');

export interface RenderResult {
  html: string;
  errors: string[];
}

export function renderMjml(mjml: string): RenderResult {
  const r = mjml2html(mjml, { validationLevel: 'soft', minify: true });
  return { html: r.html, errors: (r.errors ?? []).map((e) => e.message) };
}
