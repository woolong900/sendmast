import mjml2html from 'mjml';

export interface RenderResult {
  html: string;
  errors: string[];
}

export function renderMjml(mjml: string): RenderResult {
  const r = mjml2html(mjml, { validationLevel: 'soft', minify: false });
  return { html: r.html, errors: (r.errors ?? []).map((e) => e.message) };
}
