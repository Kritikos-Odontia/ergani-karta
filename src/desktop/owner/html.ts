// SPDX-License-Identifier: EUPL-1.2
import { MADE_BY } from '../../stamp/page.js';

/**
 * THE OWNER PAGES' HTML — server-rendered, Greek, no script at all. Every value goes through `esc`; markup is only
 * ever built here from constants. Forms post back to the same server with the session's CSRF token.
 */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Markup that is already safe (built by these helpers), as opposed to text, which `esc` takes. */
export class Html {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

/** A template tag: every interpolated value is escaped unless it is `Html` (or an array of them). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    const part = (v: unknown): string => (v instanceof Html ? v.text : Array.isArray(v) ? v.map(part).join('') : esc(v));
    out += part(value) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

export const NAV: ReadonlyArray<readonly [string, string]> = [
  ['/', 'Αρχική'],
  ['/staff', 'Προσωπικό'],
  ['/devices', 'Συσκευές'],
  ['/queue', 'Εκκρεμότητες'],
  ['/calendar', 'Ημερολόγιο'],
  ['/days', 'Κλειστές μέρες'],
  ['/records', 'Αρχείο εργαζομένου'],
  ['/accountant', 'Για τον λογιστή'],
  ['/backup', 'Αντίγραφα'],
  ['/alerts', 'Ειδοποιήσεις'],
  ['/updates', 'Ενημερώσεις'],
  ['/settings', 'Ρυθμίσεις'],
];

export function page(title: string, body: Html, options: { nav?: boolean; csrf?: string } = {}): string {
  const nav = options.nav === false
    ? html``
    : html`<nav>${NAV.map(([href, label]) => html`<a href="${href}">${label}</a>`)}<form method="post" action="/logout">${csrfField(options.csrf)}<button class="link">Αποσύνδεση</button></form></nav>`;
  return `<!doctype html>
<html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Κάρτα Εργασίας</title><link rel="stylesheet" href="/owner.css"></head>
<body><header><h1>Κάρτα Εργασίας</h1>${nav.text}</header><main><h2>${esc(title)}</h2>${body.text}</main>${MADE_BY}</body></html>`;
}

export function csrfField(csrf: string | undefined): Html {
  return csrf === undefined ? html`` : html`<input type="hidden" name="csrf" value="${csrf}">`;
}

/** A message box: `ok` (green), `warn` (amber), `bad` (red). */
export function note(kind: 'ok' | 'warn' | 'bad', text: string | Html): Html {
  return html`<p class="note ${kind}">${text}</p>`;
}

export const OWNER_CSS = `
:root { --ink: #1d2327; --soft: #eef3f4; --line: #c9d3d6; --ok: #1f7a3d; --warn: #9a5b00; --bad: #b3261e; --brand: #0e5563; }
* { box-sizing: border-box; }
body { margin: 0; font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: #fff; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 24px; background: var(--soft); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 22px; color: var(--brand); }
nav { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
nav a { color: var(--ink); text-decoration: none; }
nav a:hover { text-decoration: underline; }
main { max-width: 900px; margin: 0 auto; padding: 16px 24px 32px; }
h2 { margin-top: 8px; }
fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; padding: 12px 16px; }
legend { font-weight: 600; padding: 0 6px; }
label { display: block; margin: 10px 0 4px; font-weight: 500; }
input[type=text], input[type=password], input[type=email], input[type=number], input[type=month], input[type=date], select {
  width: 100%; max-width: 420px; padding: 8px 10px; font: inherit; border: 1px solid var(--line); border-radius: 6px; }
.settings label > input, .settings label > select { display: block; margin-top: 4px; }
.check label { display: inline; font-weight: 400; }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; }
button.secondary { background: #fff; color: var(--brand); }
button.link { background: none; border: none; color: var(--ink); padding: 0; text-decoration: underline; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.note { padding: 10px 14px; border-radius: 6px; border-left: 4px solid; }
.note.ok { border-color: var(--ok); background: #eaf6ee; }
.note.warn { border-color: var(--warn); background: #fff4e0; }
.note.bad { border-color: var(--bad); background: #fdecea; }
.hint { color: #555; font-size: 15px; }
.pin { font-size: 40px; letter-spacing: 8px; font-weight: 700; }
.qr { background: #fff; padding: 8px; display: inline-block; border: 1px solid var(--line); }
.made-by { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 16px; font-size: 14px; color: #666; }
form.inline { display: inline; }
`;
