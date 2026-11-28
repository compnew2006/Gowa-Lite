import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {phoneFromJid} from '../src/features/chat/display-name.ts';

/**
 * Phase 3 Path C — P1-12 (decision 13): the phone number may only be derived
 * from a JID that ends in @s.whatsapp.net or @c.us. An @lid JID is a linked
 * identity, not a phone number, and must never be displayed as one.
 */
describe('phoneFromJid', () => {
  it('derives the number from @s.whatsapp.net JIDs', () => {
    assert.equal(phoneFromJid('966500000001@s.whatsapp.net'), '966500000001');
  });

  it('derives the number from @c.us JIDs', () => {
    assert.equal(phoneFromJid('966500000001@c.us'), '966500000001');
  });

  it('strips a device suffix before the @', () => {
    assert.equal(phoneFromJid('966500000001:7@s.whatsapp.net'), '966500000001');
  });

  it('returns empty for @lid JIDs', () => {
    assert.equal(phoneFromJid('123456789@lid'), '');
  });

  it('returns empty for group JIDs', () => {
    assert.equal(phoneFromJid('123456789@g.us'), '');
  });

  it('returns empty for a bare number without a phone JID suffix', () => {
    assert.equal(phoneFromJid('966500000001'), '');
  });

  it('returns empty for missing JIDs', () => {
    assert.equal(phoneFromJid(''), '');
    assert.equal(phoneFromJid(undefined), '');
    assert.equal(phoneFromJid(null), '');
  });
});
