import { describe, expect, it } from 'vitest';
import { spaceIsTransport, typesWords } from '../src/app/fields.ts';

/** Just enough of an element: its tag, an input's type, editable or not, and what it sits in. */
function el(tagName: string, o: { type?: string; editable?: boolean; inside?: string[] } = {}): EventTarget {
  return {
    tagName,
    type: o.type,
    isContentEditable: !!o.editable,
    closest: (sel: string) => (sel.split(', ').some((s) => o.inside?.includes(s)) ? {} : null),
  } as unknown as EventTarget;
}
const space = (target: EventTarget | null, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) => ({
  code: 'Space',
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  target,
});

describe('Space', () => {
  it('plays and stops after a button, a checkbox, a list or a slider was used', () => {
    for (const target of [
      el('BUTTON'),
      el('INPUT', { type: 'checkbox' }),
      el('SELECT'),
      el('INPUT', { type: 'range' }),
      el('CANVAS'),
      el('BODY'),
    ]) {
      expect(spaceIsTransport(space(target), false)).toBe(true);
    }
  });

  it("plays and stops from a plugin's or the synth's window", () => {
    expect(spaceIsTransport(space(el('DIV', { inside: ['[role="dialog"]'] })), false)).toBe(true);
  });

  it('types a space in a text field, a text box or a lyric', () => {
    expect(spaceIsTransport(space(el('INPUT', { type: 'text' })), false)).toBe(false);
    expect(spaceIsTransport(space(el('INPUT', { type: 'search' })), false)).toBe(false);
    expect(spaceIsTransport(space(el('TEXTAREA')), false)).toBe(false);
    expect(spaceIsTransport(space(el('DIV', { editable: true })), false)).toBe(false);
  });

  it('is left to a menu and to a dialog over the studio', () => {
    expect(spaceIsTransport(space(el('BUTTON', { inside: ['[role="menu"]'] })), false)).toBe(false);
    expect(spaceIsTransport(space(el('BUTTON', { inside: ['[aria-modal="true"]'] })), false)).toBe(false);
    expect(spaceIsTransport(space(el('BODY')), true)).toBe(false);
  });

  it('with Ctrl, Cmd or Alt is something else', () => {
    expect(spaceIsTransport(space(el('BODY'), { ctrl: true }), false)).toBe(false);
    expect(spaceIsTransport(space(el('BODY'), { meta: true }), false)).toBe(false);
    expect(spaceIsTransport(space(el('BODY'), { alt: true }), false)).toBe(false);
  });

  it('only Space: other keys are not the transport', () => {
    expect(spaceIsTransport({ ...space(el('BODY')), code: 'Enter' }, false)).toBe(false);
  });
});

describe('a place words are typed', () => {
  it('is a text field, a text box or something editable, not a slider or a box', () => {
    expect(typesWords(el('INPUT', { type: 'number' }))).toBe(true);
    expect(typesWords(el('INPUT', { type: '' }))).toBe(true);
    expect(typesWords(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(typesWords(el('SELECT'))).toBe(false);
    expect(typesWords(null)).toBe(false);
  });
});
