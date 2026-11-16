// Small helpers shared by every screen: DOM building, API calls, formatting.

/**
 * Build a DOM node. Text always goes through textContent, so names and
 * messages from the server can never inject markup.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  activity: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  contacts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18.5 14.9c1.7.8 2.7 2.5 3 5.1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.3 2.9 8.1 7 9.5 4.1-1.4 7-5.2 7-9.5V6z"/><path d="m9 12 2.2 2.2L15 10.4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 3 3"/>',
  dial: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18h3"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  returned: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
};

/** Inline icon from the fixed set above (trusted markup, never user data). */
export function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// --- API ---------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('You appear to be offline. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new ApiError(data?.error || `Something went wrong (${res.status}).`, res.status);
    if (res.status === 401 && !path.startsWith('/api/auth/') && !/\/confirm$/.test(path)) onUnauthorized();
    throw error;
  }
  return data;
}

// --- Formatting --------------------------------------------------------------

const money = new Intl.NumberFormat('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatGHS(pesewas) {
  return `GHS ${money.format((pesewas ?? 0) / 100)}`;
}

/** Split for display where the pesewas are set smaller than the cedis. */
export function moneyParts(pesewas) {
  const [whole, frac] = money.format((pesewas ?? 0) / 100).split('.');
  return { whole, frac };
}

export function formatWhen(iso) {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }) + `, ${time}`;
}

export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '#';
  if (/^[\d+]/.test(words[0])) return '#';
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
}

/** Stable hue per name so each contact keeps its colour. */
export function hueFor(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

const PREFIXES = {
  '024': 'mtn', '025': 'mtn', '053': 'mtn', '054': 'mtn', '055': 'mtn', '059': 'mtn',
  '020': 'telecel', '050': 'telecel',
  '026': 'airteltigo', '027': 'airteltigo', '056': 'airteltigo', '057': 'airteltigo',
};
export const NETWORK_LABELS = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };

/** Normalise what was typed to local digits ("0241234567"), or '' if it cannot be a Ghana number yet. */
export function localDigits(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('233')) digits = '0' + digits.slice(3);
  return digits;
}

/** Instant feedback while typing a number. The server has the final say. */
export function guessNetwork(input) {
  const digits = localDigits(input);
  return digits.length >= 3 ? PREFIXES[digits.slice(0, 3)] ?? null : null;
}

// --- Toasts ------------------------------------------------------------------

export function toast(message, tone = 'info') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${tone}` }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 250);
  }, tone === 'error' ? 5500 : 3200);
}
