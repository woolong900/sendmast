import { toPng } from 'html-to-image';
import { uploadEditorImage } from '@/lib/easy-email-upload';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';

/**
 * Generate + upload in one call. Returns the public URL on success, null on
 * any failure (caller MUST tolerate — campaign save still works without a
 * thumbnail; list page falls back to a placeholder).
 */
export async function captureAndUploadThumbnail(html: string): Promise<string | null> {
  const blob = await generateEmailThumbnail(applyMergePreviewSamples(html));
  if (!blob) return null;
  try {
    const file = new File([blob], `thumbnail.png`, { type: 'image/png' });
    return await uploadEditorImage(file);
  } catch (err) {
    console.warn('[thumbnail] upload failed:', err);
    return null;
  }
}

/**
 * Render the rendered email HTML into a hidden, fixed-size iframe and snapshot
 * it into a PNG Blob. Used at content-save time so the campaign list page can
 * display a static thumbnail instead of mounting 50 sandboxed iframes.
 *
 * Why an iframe (not a plain div):
 *   MJML's output is a full `<html><head><style>…</style></head><body>…</body></html>`
 *   document. Pasted into the host page, the `<style>` block would leak into
 *   the app's own styles, and `<html>`/`<body>` outside their roots are
 *   ignored entirely. Same-origin `srcDoc` gives a clean isolated render
 *   while still letting html-to-image walk the iframe's body.
 *
 * Why fixed render width 600px (not 100% / device width):
 *   Email clients converge around ~600px content width, which is also Easy
 *   Email's canvas width. Snapshotting at that width gets the layout that
 *   matches what the user just composed; downscaling on the consumer side
 *   (88×88 or 420×480) is then a clean bilinear shrink.
 *
 * Returns null on any failure (timeout, html-to-image error, oversize). The
 * caller MUST tolerate this — saving without a thumbnail still works,
 * the list page falls back to a placeholder.
 */
export async function generateEmailThumbnail(html: string): Promise<Blob | null> {
  if (!html || html.trim().length === 0) return null;

  const iframe = document.createElement('iframe');
  // `position:fixed; opacity:0` keeps the iframe interactive enough for the
  // browser to fully lay it out (display:none would skip layout) but
  // invisible and non-clickable for the user.
  iframe.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:600px',
    'height:1200px',
    'border:0',
    'opacity:0',
    'pointer-events:none',
    'z-index:-1',
  ].join(';');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.srcdoc = html;
  document.body.appendChild(iframe);

  try {
    // Wait until the iframe is laid out enough to snapshot — but DON'T block on
    // the `load` event. `load` only fires once every subresource (incl. every
    // external <img>) has finished, so an email referencing remote images would
    // stall here until the 4s ceiling and we'd bail with no thumbnail, silently
    // keeping the previously-stored (often the HTML_STARTER) image. Cross-origin
    // images can't be embedded into the canvas anyway (CORS taint → html-to-image
    // skips them), so waiting for them buys nothing. Instead: take whichever
    // comes first between `load` and a short fallback delay, then give layout a
    // couple of frames. We resolve (never reject) so generation always proceeds.
    await new Promise<void>((resolve) => {
      let settled = false;
      const proceed = () => {
        if (settled) return;
        settled = true;
        // Two paint frames so html-to-image sees the final laid-out DOM.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      };
      iframe.addEventListener('load', proceed, { once: true });
      // Fallback: snapshot the laid-out HTML even if remote images keep `load`
      // pending. 1.2s is plenty for the browser to parse + lay out inline markup.
      setTimeout(proceed, 1200);
    });

    const doc = iframe.contentDocument;
    if (!doc?.body) return null;

    // Crop the snapshot to the actual content height (capped) — emails are
    // tall but the thumbnail use case only needs the top portion to be
    // recognisable.
    const contentHeight = Math.min(
      Math.max(doc.body.scrollHeight, 400),
      1200,
    );

    const dataUrl = await toPng(doc.body, {
      width: 600,
      height: contentHeight,
      pixelRatio: 1, // 1x is plenty at 88×88 / 420×480 display sizes
      cacheBust: false,
      backgroundColor: '#ffffff',
      // Skip embedding cross-origin images — saves time and avoids CORS
      // taint that would refuse the canvas export. The thumbnail will show
      // alt text or broken-image icons in those slots; fine for a 88x88.
      skipFonts: true,
    });

    return await dataUrlToBlob(dataUrl);
  } catch (err) {
    // Soft-fail. Caller logs and proceeds without a thumbnail.
    console.warn('[thumbnail] generation failed:', err);
    return null;
  } finally {
    iframe.remove();
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // fetch() is the cleanest dataURL → Blob converter and is supported in
  // every browser we target. Avoids hand-rolling base64 → Uint8Array.
  const r = await fetch(dataUrl);
  return await r.blob();
}
