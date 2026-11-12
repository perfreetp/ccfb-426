/** 轻量 DOM 构造辅助 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | EventListener | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** 滑块 + 数值输出 */
export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  format: (v: number) => string = (v) => v.toFixed(2),
): HTMLElement {
  const out = h('output', { text: format(value) });
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: () => {
      const v = parseFloat((input as HTMLInputElement).value);
      out.textContent = format(v);
      onChange(v);
    },
  }) as HTMLInputElement;
  return h('div', { class: 'field' }, h('label', {}, document.createTextNode(label), out), input);
}

/** [r,g,b] 0~1 -> #rrggbb */
export function rgbToHex(c: [number, number, number]): string {
  const f = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, (n >> 8) & 255 / 255, (n & 255) / 255];
}

let toastWrap: HTMLElement | null = null;
export function toast(message: string, error = false, duration = 2600): void {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap' });
    document.body.appendChild(toastWrap);
  }
  const t = h('div', { class: error ? 'toast error' : 'toast', text: message });
  toastWrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(() => t.remove(), 320);
  }, duration);
}

export function download(filename: string, url: string): void {
  const a = h('a', { href: url, download: filename }) as HTMLAnchorElement;
  a.click();
}
