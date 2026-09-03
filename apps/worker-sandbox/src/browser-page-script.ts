/**
 * The DOM walk that turns a live page into a snapshot — run INSIDE the
 * browser via `page.evaluate`, which is why it is one self-contained
 * function with every helper nested: Playwright serializes it by source,
 * so nothing here may reference a module-level binding. The output shape
 * is @renkei/connector-sandbox's `BrowserSnapshotNode`; the rendering
 * into text happens back in the worker.
 *
 * What it does, in order, per visible element:
 *  - interactive things (links, buttons, form controls, ARIA widgets,
 *    contenteditable) get a fresh `data-renkei-ref="eN"` stamped on the
 *    element and are reported with their accessible name and state; the
 *    walk does not descend into them (their text IS their name);
 *  - headings, images with alt text, and landmarks are reported as
 *    structure;
 *  - everything else contributes text — a subtree with nothing
 *    interactive inside is flattened to one line via innerText, so a
 *    paragraph with inline formatting reads as a paragraph.
 *
 * Bounded by `maxNodes`: past it the walk stops and says so, which the
 * renderer surfaces to the model. Password values are masked; every string
 * is collapsed and capped so a hostile page cannot flood the snapshot.
 */

import type { BrowserSnapshotNode } from '@renkei/connector-sandbox';

export interface PageWalkResult {
  nodes: BrowserSnapshotNode[];
  truncated: boolean;
}

export const REF_ATTRIBUTE = 'data-renkei-ref';

/** Stamped by the worker on a control it filled from a secret; the walk masks its value. */
export const SECRET_ATTRIBUTE = 'data-renkei-secret';

/**
 * The walk as a self-contained expression for `page.evaluate(string)`.
 *
 * Not `page.evaluate(collectSnapshotInPage, ...)`, on purpose: this worker
 * runs under tsx (esbuild with keepNames), which rewrites every nested
 * function into a `__name(fn, "fn")` helper call — and that helper exists
 * only in the worker process, so Playwright's function serialization ships
 * a body that throws `__name is not defined` in the page. Wrapping the
 * function's source text in a scope that defines a no-op `__name` makes it
 * run the same under tsx, ts-jest, or plain node.
 */
export function pageScriptSource(maxNodes: number, attribute = REF_ATTRIBUTE): string {
  const bound = Math.max(1, Math.floor(maxNodes));
  return `(() => { const __name = (fn) => fn; return (${collectSnapshotInPage.toString()})(${bound}, ${JSON.stringify(attribute)}); })()`;
}

export function collectSnapshotInPage(
  maxNodes: number,
  refAttribute = 'data-renkei-ref'
): PageWalkResult {
  // The attribute refs are stamped on. A snapshot bound for the model uses
  // the real one; a recovery walk (browser.ts, requireRef) uses a probe
  // attribute so it never disturbs the numbering the model already holds.
  const REF_ATTR = refAttribute;
  const SECRET_ATTR = 'data-renkei-secret';
  const MASK = '••••••';
  const NAME_MAX = 200;
  const TEXT_MAX = 1000;
  const OPTIONS_MAX = 50;
  const HREF_MAX = 300;
  const SKIP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'head',
    'meta',
    'link',
    'iframe',
    'object',
    'embed',
    'canvas',
    'video',
    'audio',
    'map',
  ]);
  const LANDMARK_TAGS: Record<string, string> = {
    nav: 'nav',
    main: 'main',
    header: 'header',
    footer: 'footer',
    aside: 'aside',
    form: 'form',
    dialog: 'dialog',
    table: 'table',
  };
  const LANDMARK_ROLES: Record<string, string> = {
    navigation: 'nav',
    main: 'main',
    banner: 'header',
    contentinfo: 'footer',
    complementary: 'aside',
    form: 'form',
    dialog: 'dialog',
    alertdialog: 'dialog',
    search: 'search',
    region: 'region',
    table: 'table',
    grid: 'table',
  };
  const WIDGET_ROLES: Record<string, string> = {
    button: 'button',
    link: 'link',
    checkbox: 'checkbox',
    radio: 'radio',
    combobox: 'combobox',
    listbox: 'listbox',
    textbox: 'textbox',
    searchbox: 'searchbox',
    switch: 'switch',
    tab: 'tab',
    menuitem: 'menuitem',
    menuitemcheckbox: 'menuitem',
    menuitemradio: 'menuitem',
    option: 'option',
    slider: 'slider',
  };
  // Anything the walk reports on its own line; a subtree with none of these
  // inside is flattened to one text line.
  const STRUCTURE_SELECTOR =
    'a[href],button,input,select,textarea,summary,[role],[contenteditable],' +
    'h1,h2,h3,h4,h5,h6,img[alt],nav,main,header,footer,aside,form,dialog,table';

  const nodes: BrowserSnapshotNode[] = [];
  let truncated = false;
  let nextRef = 1;

  for (const stale of Array.from(document.querySelectorAll(`[${REF_ATTR}]`))) {
    stale.removeAttribute(REF_ATTR);
  }

  const collapse = (value: string | null | undefined, max: number): string => {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const isVisible = (el: Element): boolean => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (!(el instanceof HTMLElement)) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // display:contents boxes have no rects of their own but their children do.
    if (style.display === 'contents') return true;
    return el.getClientRects().length > 0;
  };

  const labelledBy = (el: Element): string => {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    return collapse(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
      NAME_MAX
    );
  };

  const nameOf = (el: Element): string => {
    const aria = collapse(el.getAttribute('aria-label'), NAME_MAX);
    if (aria) return aria;
    const by = labelledBy(el);
    if (by) return by;
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const labels = el.labels ? Array.from(el.labels) : [];
      const fromLabels = collapse(
        labels.map((label) => label.textContent ?? '').join(' '),
        NAME_MAX
      );
      if (fromLabels) return fromLabels;
      const placeholder = collapse(el.getAttribute('placeholder'), NAME_MAX);
      if (placeholder) return placeholder;
      if (el instanceof HTMLInputElement && /^(submit|button|reset)$/i.test(el.type) && el.value) {
        return collapse(el.value, NAME_MAX);
      }
      const title = collapse(el.getAttribute('title'), NAME_MAX);
      if (title) return title;
      return collapse(el.getAttribute('name'), NAME_MAX);
    }
    const text = collapse(el instanceof HTMLElement ? el.innerText : el.textContent, NAME_MAX);
    if (text) return text;
    const img = el.querySelector('img[alt]');
    const alt = collapse(img?.getAttribute('alt'), NAME_MAX);
    if (alt) return alt;
    return collapse(el.getAttribute('title'), NAME_MAX);
  };

  const interactiveRoleOf = (el: Element): BrowserSnapshotNode['role'] | null => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el instanceof HTMLInputElement) {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image')
        return 'button';
      if (type === 'file') return 'file';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      // Only the outermost editable region gets a ref; its children are its content.
      const parent = el.parentElement;
      if (!(parent instanceof HTMLElement) || !parent.isContentEditable) return 'editable';
      return null;
    }
    const explicit = (el.getAttribute('role') ?? '').toLowerCase();
    const widget = WIDGET_ROLES[explicit];
    // Cast: WIDGET_ROLES only ever holds interactive role names.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return widget ? (widget as BrowserSnapshotNode['role']) : null;
  };

  const emitInteractive = (el: Element, role: BrowserSnapshotNode['role']): void => {
    const ref = `e${nextRef++}`;
    el.setAttribute(REF_ATTR, ref);
    const node: BrowserSnapshotNode = { role, ref, name: nameOf(el) };
    const secret = el.hasAttribute(SECRET_ATTR);
    if (role === 'link' && el instanceof HTMLAnchorElement) {
      node.href = collapse(el.href, HREF_MAX);
    }
    if (el instanceof HTMLInputElement) {
      if (role === 'checkbox' || role === 'radio') {
        node.checked = el.checked;
      } else if (role !== 'button' && role !== 'file') {
        node.value =
          el.type === 'password' || secret ? (el.value ? MASK : '') : collapse(el.value, NAME_MAX);
      }
      if (el.disabled) node.disabled = true;
    } else if (el instanceof HTMLTextAreaElement) {
      node.value = secret ? (el.value ? MASK : '') : collapse(el.value, NAME_MAX);
      if (el.disabled) node.disabled = true;
    } else if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      node.options = options
        .slice(0, OPTIONS_MAX)
        .map((option) => collapse(option.label || option.text, NAME_MAX));
      node.value = options
        .filter((option) => option.selected)
        .map((option) => collapse(option.label || option.text, NAME_MAX))
        .join(', ');
      if (el.disabled) node.disabled = true;
    } else {
      const ariaChecked = el.getAttribute('aria-checked');
      if (ariaChecked === 'true' || ariaChecked === 'false') node.checked = ariaChecked === 'true';
      const ariaPressed = el.getAttribute('aria-pressed');
      if (node.checked === undefined && (ariaPressed === 'true' || ariaPressed === 'false')) {
        node.checked = ariaPressed === 'true';
      }
      if (
        el.getAttribute('aria-disabled') === 'true' ||
        (el instanceof HTMLButtonElement && el.disabled)
      ) {
        node.disabled = true;
      }
      if (role === 'editable' && el instanceof HTMLElement) {
        node.value = secret ? (el.innerText.trim() ? MASK : '') : collapse(el.innerText, NAME_MAX);
      }
    }
    nodes.push(node);
  };

  const push = (node: BrowserSnapshotNode): boolean => {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return false;
    }
    nodes.push(node);
    return true;
  };

  const walk = (el: Element): void => {
    if (truncated) return;
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (!isVisible(el)) return;

    const role = interactiveRoleOf(el);
    if (role) {
      emitInteractive(el, role);
      return;
    }

    const explicitRole = (el.getAttribute('role') ?? '').toLowerCase();
    const headingLevel = /^h[1-6]$/.test(tag)
      ? Number(tag.slice(1))
      : explicitRole === 'heading'
        ? Math.min(Math.max(Number(el.getAttribute('aria-level') ?? '2') || 2, 1), 6)
        : 0;
    if (headingLevel > 0) {
      const name = collapse(el instanceof HTMLElement ? el.innerText : el.textContent, NAME_MAX);
      if (name) push({ role: 'heading', level: headingLevel, name });
      return;
    }

    if (tag === 'img') {
      const alt = collapse(el.getAttribute('alt'), NAME_MAX);
      if (alt) push({ role: 'image', name: alt });
      return;
    }

    const landmark = LANDMARK_TAGS[tag] ?? LANDMARK_ROLES[explicitRole];
    if (landmark) {
      const label =
        collapse(el.getAttribute('aria-label'), NAME_MAX) ||
        labelledBy(el) ||
        (tag === 'table' ? collapse(el.querySelector('caption')?.textContent, NAME_MAX) : '');
      if (!push({ role: 'landmark', tag: landmark, name: label })) return;
    }

    if (!el.querySelector(STRUCTURE_SELECTOR)) {
      // Nothing to report on its own inside: one line of text for the subtree.
      const text = collapse(el instanceof HTMLElement ? el.innerText : el.textContent, TEXT_MAX);
      if (text) push({ role: 'text', name: text });
      return;
    }

    let direct = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) direct += child.textContent ?? '';
    }
    const directText = collapse(direct, TEXT_MAX);
    if (directText && !push({ role: 'text', name: directText })) return;

    for (const child of Array.from(el.children)) {
      if (truncated) return;
      walk(child);
    }
  };

  if (document.body) walk(document.body);
  return { nodes, truncated };
}
