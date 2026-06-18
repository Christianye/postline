import { describe, expect, it } from 'vitest';
import { onboardingHint } from './im-bridge.js';

describe('onboardingHint', () => {
  it('self-introduces + shows the dispatch shape with the configured wake-name', () => {
    const out = onboardingHint('pl');
    expect(out).toMatch(/I'm postline/);
    expect(out).toContain('!pl@<repo>');
    // no resolved repo → points at the explicit form + embeddedLlm escape hatch
    expect(out).toMatch(/no repo resolved/);
    expect(out).toMatch(/embeddedLlm\.enabled/);
  });

  it('honours a custom wake-name', () => {
    expect(onboardingHint('bot')).toContain('!bot@<repo>');
  });

  it('uses the near-miss repo as the example when one is hinted', () => {
    const out = onboardingHint('pl', 'acme-api');
    expect(out).toContain('!pl@acme-api');
    expect(out).toMatch(/couldn't tell which repo/i);
  });
});
