// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/config.js';
import { loadStampSettings } from '../src/stamp/config.js';
import { EASY_TITLE, EASY_TOPIC, NAMELESS, namelessSender, namelessText, newEasyTopic, ntfySender } from '../src/stamp/notify.js';
import { AFM } from './fixtures/people.js';

/**
 * THE EASY PHONE ALERTS (his «Yes», 21/10) — nameless pushes through the public ntfy.sh. ⛔ What is held IN CODE: the
 * easy sender never sends a word of the push it is given — only a fixed sentence for the alarm's kind, under a fixed
 * title; and a push that names a person (`ntfySender`) never goes to ntfy.sh, refused when it would send as well as in
 * the settings. No request leaves the test: the transport is recorded.
 */
function recorder() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { sent, transport };
}

const NAMED = {
  title: 'ΕΡΓΑΝΗ — Οδοντιατρείο Παράδειγμα',
  message: `Άλφα Παράδειγμα — η κάρτα ΕΝΑΡΞΗ (09:02) δεν στάλθηκε στην ΕΡΓΑΝΗ · ${AFM.alfa}`,
  priority: 4 as const,
};

describe('the easy mode — nameless, through ntfy.sh', () => {
  it('sends only a fixed sentence and a fixed title — never a word of the push it is given', async () => {
    const { sent, transport } = recorder();
    const topic = newEasyTopic();
    await namelessSender(topic, transport)(NAMED, 'queue:12');
    expect(sent).toEqual([{ url: 'https://ntfy.sh/', body: { topic, title: EASY_TITLE, message: NAMELESS['queue'], priority: 4 } }]);
    const wire = JSON.stringify(sent);
    for (const leak of ['Άλφα', 'Παράδειγμα', 'Οδοντιατρείο', AFM.alfa, '09:02']) expect(wire).not.toContain(leak);
  });

  it('every kind of alarm maps to one of the fixed sentences, and none of them carries a number or a name slot', () => {
    const kinds = new Set([...readFileSync(new URL('../src/stamp/alarms.ts', import.meta.url), 'utf8').matchAll(/`([a-z]+(?:-[a-z]+)*):\$\{/g)].map((m) => m[1]!));
    kinds.delete('alarms');
    expect(kinds.size).toBeGreaterThan(5);
    for (const kind of kinds) expect(Object.keys(NAMELESS), `alarm kind «${kind}» has no nameless sentence`).toContain(kind);
    for (const sentence of Object.values(NAMELESS)) expect(sentence).not.toMatch(/\d|\$\{/);
    expect(namelessText('something-new:1')).toBe(NAMELESS['other']);
    expect(namelessText(undefined)).toBe(NAMELESS['other']);
  });

  it('only a long random topic of its own making', () => {
    expect(newEasyTopic()).toMatch(EASY_TOPIC);
    expect(newEasyTopic()).not.toBe(newEasyTopic());
    expect(() => namelessSender('ergani')).toThrow();
  });
});

describe('⛔ a push with names never goes to ntfy.sh', () => {
  it('refused when it would send — not only in the settings', async () => {
    const { sent, transport } = recorder();
    for (const url of ['https://ntfy.sh/ergani-x', 'https://NTFY.SH./ergani-x', 'https://eu.ntfy.sh/ergani-x']) {
      await expect(ntfySender(new Secret(url), new Secret('tk_fabricated'), transport)(NAMED)).rejects.toThrow(/never sent to ntfy\.sh/);
    }
    expect(sent).toEqual([]);
  });

  it('the settings: the easy topic is one or the other with an own server, and only a topic of the right shape', () => {
    const base = { STAMP_INSTANCE: 'testclinic', STAMP_DB: '/tmp/x.sqlite' };
    const topic = newEasyTopic();
    expect(loadStampSettings({ ...base, NTFY_EASY_TOPIC: topic }).easyTopic).toBe(topic);
    expect(() => loadStampSettings({ ...base, NTFY_EASY_TOPIC: topic, NTFY_URL: 'https://ntfy.example.invalid/x', NTFY_TOKEN: 'tk' })).toThrow(/one or the other/);
    expect(() => loadStampSettings({ ...base, NTFY_EASY_TOPIC: 'short' })).toThrow(/NTFY_EASY_TOPIC/);
  });
});
