/**
 * Mode 1, step 5: URL analysis (BUILD_PLAN.md).
 *
 * Loads a URL in headless Chromium, saves a full-page screenshot and a
 * page.json listing the page's interactive elements.
 *
 * Usage (from apps/api):  npm run analyze -- https://example.com
 */
import { chromium, errors } from 'playwright';
import { LocalDiskStorage, StorageProvider } from './storage';

const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

export interface ElementInfo {
  selector: string;
  text: string;
  role: string | null;
  visible: boolean;
  type?: string | null;
  name?: string | null;
  placeholder?: string | null;
  label?: string | null;
  href?: string | null;
  action?: string | null;
  method?: string | null;
  value?: string | null;
  options?: string[];
}

export interface PageElements {
  forms: ElementInfo[];
  inputs: ElementInfo[];
  buttons: ElementInfo[];
  links: ElementInfo[];
  dropdowns: ElementInfo[];
  checkboxes: ElementInfo[];
  radio_buttons: ElementInfo[];
  navigation: ElementInfo[];
  modals: ElementInfo[];
}

export interface PageAnalysis {
  url: string;
  final_url: string;
  title: string;
  http_status: number | null;
  analyzed_at: string;
  screenshot: string;
  counts: Record<keyof PageElements, number>;
  elements: PageElements;
}

export interface AnalysisResult {
  analysis: PageAnalysis;
  /** PNG bytes of the full-page screenshot. */
  screenshot: Buffer;
  screenshotPath: string;
  pageJsonPath: string;
}

export class AnalysisError extends Error {}

export function parseUrl(input: string | undefined): URL {
  if (!input) {
    throw new AnalysisError(
      'No URL given. Usage: npm run analyze -- https://example.com',
    );
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AnalysisError(
      `Invalid URL: "${input}". Include the scheme, e.g. https://example.com`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AnalysisError(
      `Unsupported URL scheme "${url.protocol}" in "${input}". Only http and https are allowed.`,
    );
  }
  return url;
}

function describeNavigationError(err: unknown, url: string): AnalysisError {
  if (err instanceof errors.TimeoutError) {
    return new AnalysisError(
      `Timed out after ${NAVIGATION_TIMEOUT_MS / 1000}s waiting for ${url} to load.`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const netError = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  const reasons: Record<string, string> = {
    ERR_NAME_NOT_RESOLVED: 'the host name could not be resolved',
    ERR_CONNECTION_REFUSED: 'the connection was refused',
    ERR_CONNECTION_TIMED_OUT: 'the connection timed out',
    ERR_INTERNET_DISCONNECTED: 'there is no internet connection',
    ERR_CERT_AUTHORITY_INVALID: 'the SSL certificate is not trusted',
    ERR_CERT_COMMON_NAME_INVALID: 'the SSL certificate does not match the host',
  };
  if (netError) {
    return new AnalysisError(
      `Could not load ${url}: ${reasons[netError] ?? netError}.`,
    );
  }
  return new AnalysisError(`Could not load ${url}: ${message.split('\n')[0]}`);
}

/**
 * Runs inside the browser. Must be self-contained: Playwright serializes it.
 */
function extractElements(): PageElements {
  const cssEscape = (value: string) => CSS.escape(value);

  const isUnique = (selector: string) => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  const pathSelector = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      if (node.id && isUnique(`#${cssEscape(node.id)}`)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName,
      );
      parts.unshift(
        sameTag.length > 1
          ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
          : tag,
      );
      node = parent;
    }
    return parts.join(' > ');
  };

  // Prefer attributes that survive layout changes; fall back to a DOM path.
  const stableSelector = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const candidates: string[] = [];
    if (el.id) candidates.push(`#${cssEscape(el.id)}`);
    for (const attr of ['data-testid', 'data-test', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) candidates.push(`[${attr}="${cssEscape(v)}"]`);
    }
    const name = el.getAttribute('name');
    if (name) {
      const type = el.getAttribute('type');
      candidates.push(`${tag}[name="${cssEscape(name)}"]`);
      if (type && el.getAttribute('value') !== null) {
        candidates.push(
          `${tag}[name="${cssEscape(name)}"][value="${cssEscape(el.getAttribute('value')!)}"]`,
        );
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria) candidates.push(`${tag}[aria-label="${cssEscape(aria)}"]`);
    const href = el.getAttribute('href');
    if (tag === 'a' && href) candidates.push(`a[href="${cssEscape(href)}"]`);
    return candidates.find(isUnique) ?? pathSelector(el);
  };

  const clean = (s: string | null | undefined, max = 200) => {
    const text = (s ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  const isVisible = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const implicitRole = (el: Element): string | null => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : null;
      case 'button':
        return 'button';
      case 'form':
        return 'form';
      case 'nav':
        return 'navigation';
      case 'dialog':
        return 'dialog';
      case 'textarea':
        return 'textbox';
      case 'select':
        return el.hasAttribute('multiple') ||
          Number(el.getAttribute('size')) > 1
          ? 'listbox'
          : 'combobox';
      case 'input':
        if (['button', 'submit', 'reset', 'image'].includes(type))
          return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden') return null;
        return 'textbox';
      default:
        return null;
    }
  };

  const roleOf = (el: Element) => el.getAttribute('role') ?? implicitRole(el);

  const labelOf = (el: Element): string | null => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const text = Array.from(labels)
        .map((l) => l.textContent)
        .join(' ');
      if (clean(text)) return clean(text);
    }
    return clean(el.getAttribute('aria-label')) || null;
  };

  const visibleText = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type))
        return clean((el as HTMLInputElement).value);
      return clean(labelOf(el));
    }
    if (tag === 'select' || tag === 'textarea') return clean(labelOf(el));
    return clean((el as HTMLElement).innerText ?? el.textContent);
  };

  const base = (el: Element): ElementInfo => ({
    selector: stableSelector(el),
    text: visibleText(el),
    role: roleOf(el),
    visible: isVisible(el),
  });

  const field = (el: Element): ElementInfo => ({
    ...base(el),
    type:
      el.tagName.toLowerCase() === 'input'
        ? (el.getAttribute('type') ?? 'text').toLowerCase()
        : el.tagName.toLowerCase(),
    name: el.getAttribute('name'),
    placeholder: el.getAttribute('placeholder'),
    label: labelOf(el),
  });

  const all = (selector: string) =>
    Array.from(new Set(document.querySelectorAll(selector)));

  const buttonTypes = ['button', 'submit', 'reset', 'image'];
  const nonTextInputs = [...buttonTypes, 'checkbox', 'radio', 'hidden'];

  return {
    forms: all('form').map((el) => ({
      ...base(el),
      name: el.getAttribute('name'),
      action: (el as HTMLFormElement).action || null,
      method: (el.getAttribute('method') ?? 'get').toLowerCase(),
    })),
    inputs: all('input, textarea, [role="textbox"], [role="searchbox"]')
      .filter(
        (el) =>
          !(
            el.tagName === 'INPUT' &&
            nonTextInputs.includes(
              (el.getAttribute('type') ?? 'text').toLowerCase(),
            )
          ),
      )
      .map(field),
    buttons: all(
      buttonTypes.map((t) => `input[type="${t}"]`).join(', ') +
        ', button, [role="button"]',
    ).map((el) => ({ ...base(el), type: el.getAttribute('type') })),
    links: all('a[href], [role="link"]').map((el) => ({
      ...base(el),
      href: el.getAttribute('href'),
    })),
    dropdowns: all('select, [role="combobox"], [role="listbox"]').map((el) => ({
      ...field(el),
      options:
        el.tagName === 'SELECT'
          ? Array.from((el as HTMLSelectElement).options).map((o) =>
              clean(o.text),
            )
          : undefined,
    })),
    checkboxes: all('input[type="checkbox"], [role="checkbox"]').map((el) => ({
      ...field(el),
      value: el.getAttribute('value'),
    })),
    radio_buttons: all('input[type="radio"], [role="radio"]').map((el) => ({
      ...field(el),
      value: el.getAttribute('value'),
    })),
    navigation: all('nav, [role="navigation"]').map((el) => ({
      ...base(el),
      label: labelOf(el),
    })),
    modals: all(
      'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ).map(base),
  };
}

export async function analyzePage(
  rawUrl: string,
  storage: StorageProvider = new LocalDiskStorage(),
): Promise<AnalysisResult> {
  const url = parseUrl(rawUrl).toString();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = `analysis/${timestamp}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'load',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (err) {
      throw describeNavigationError(err, url);
    }
    // Give late XHR/JS a chance to settle; some pages never go fully idle.
    await page
      .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => undefined);

    const status = response?.status() ?? null;
    if (status !== null && status >= 400) {
      console.warn(`Warning: ${url} responded with HTTP ${status}.`);
    }

    const elements = await page.evaluate(extractElements);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });

    const analysis: PageAnalysis = {
      url,
      final_url: page.url(),
      title: await page.title(),
      http_status: status,
      analyzed_at: new Date().toISOString(),
      screenshot: 'page.png',
      counts: Object.fromEntries(
        Object.entries(elements).map(([k, v]: [string, ElementInfo[]]) => [
          k,
          v.length,
        ]),
      ) as PageAnalysis['counts'],
      elements,
    };

    const screenshotPath = await storage.save(`${folder}/page.png`, screenshot);
    const pageJsonPath = await storage.save(
      `${folder}/page.json`,
      JSON.stringify(analysis, null, 2) + '\n',
    );
    return { analysis, screenshot, screenshotPath, pageJsonPath };
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const { analysis, screenshotPath, pageJsonPath } = await analyzePage(
      process.argv[2],
    );
    console.log(`Analyzed ${analysis.final_url} ("${analysis.title}")`);
    console.log(
      'Elements:',
      Object.entries(analysis.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', '),
    );
    console.log(`Screenshot: ${screenshotPath}`);
    console.log(`page.json:  ${pageJsonPath}`);
  } catch (err) {
    if (err instanceof AnalysisError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
