/**
 * Patch easy-email v4 OSS's Raw block so it can be selected by clicking on
 * the canvas, the way every other block can.
 *
 * The bug: easy-email's canvas uses event delegation — clicks bubble up the
 * iframe DOM until a `.email-block` ancestor is found, at which point
 * setFocusIdx is called with that node's idx. Every block type EXCEPT Raw
 * gets `.email-block` injected automatically: in test mode `BasicBlock`
 * passes `css-class="email-block node-idx-… node-type-…"` on the mj-* tag
 * and mjml renders it onto the wrapping element. Raw compiles to `<mj-raw>`
 * which is "passthrough" — mjml ignores `css-class` on it — so the canvas
 * DOM never gains a `.email-block` wrapper around Raw content. Result: a
 * Raw block focuses once on drop (Easy Email calls setFocusIdx explicitly
 * then), but subsequent clicks fail to bubble to a match and focus stays
 * on whatever block the user was previously on. The right-side panel keeps
 * showing the previous block's editor.
 *
 * The fix: re-register Raw with a render that wraps the user-typed content
 * in a `<div class="email-block node-idx-… node-type-raw">…</div>` while
 * we're rendering the canvas (mode === 'testing'). In production we leave
 * the content untouched so exported MJML / HTML stays clean.
 *
 * Side-effect module: import order matters — see easy-email-image-overrides.
 */
import React from 'react';
import {
  BasicType,
  BlockManager,
  EMAIL_BLOCK_CLASS_NAME,
  getAdapterAttributesString,
  getNodeIdxClassName,
  getNodeTypeClassName,
  type IBlock,
} from 'easy-email-core';

const originalRaw = BlockManager.getBlockByType(BasicType.RAW);

if (originalRaw) {
  const patchedRender: IBlock['render'] = (params) => {
    const { idx, mode } = params;
    const rawContent: string =
      (params.data?.data?.value as { content?: string } | undefined)?.content ?? '';

    const wrappedContent =
      mode === 'testing' && idx
        ? `<div class="${EMAIL_BLOCK_CLASS_NAME} ${getNodeIdxClassName(idx)} ${getNodeTypeClassName(BasicType.RAW)}">${rawContent}</div>`
        : rawContent;

    return React.createElement(
      React.Fragment,
      null,
      `<mj-raw ${getAdapterAttributesString(params)}>`,
      wrappedContent,
      '</mj-raw>',
    );
  };

  // IMPORTANT: do NOT use `{ ...originalRaw, render: ... }` — easy-email-core
  // defines `name` as a `get name()` accessor that calls `t("Raw")` lazily so
  // it tracks the active locale. Object spread invokes the getter once at
  // spread time and writes the resolved value as a plain string property —
  // this happens at module load, before LanguageProvider installs our zh-CN
  // dict, so `name` would freeze as the English fallback "Raw" forever (and
  // any later locale changes silently no-op). Copy the property descriptors
  // instead so the getter stays a getter.
  const patchedRaw = Object.defineProperties(
    {} as IBlock,
    {
      ...Object.getOwnPropertyDescriptors(originalRaw),
      render: { value: patchedRender, writable: true, configurable: true, enumerable: true },
    },
  );

  BlockManager.registerBlocks({ [BasicType.RAW]: patchedRaw });
}
