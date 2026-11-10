import { describe, expect, it } from 'vitest';
import { browserMenuWanted } from '../src/app/right-click.ts';
import { isMenuPress } from '../src/ui/gesture.ts';

/** Just enough of an element for the rule: its tag, an input's type, and whether it sits in a link. */
function el(tagName: string, o: { type?: string; editable?: boolean; inLink?: boolean } = {}): EventTarget {
  return {
    tagName,
    type: o.type,
    isContentEditable: !!o.editable,
    closest: (sel: string) => (sel === 'a[href]' && o.inLink ? {} : null),
  } as unknown as EventTarget;
}

describe('the browser menu on right-click', () => {
  it('stays shut over the studio: canvases, slots, buttons, the menu backdrop', () => {
    for (const tag of ['CANVAS', 'DIV', 'SPAN', 'BUTTON', 'SELECT', 'SECTION']) {
      expect(browserMenuWanted(el(tag), false)).toBe(false);
    }
    expect(browserMenuWanted(null, false)).toBe(false);
  });

  it('opens in a field being typed in, for paste and spelling', () => {
    expect(browserMenuWanted(el('TEXTAREA'), false)).toBe(true);
    expect(browserMenuWanted(el('DIV', { editable: true }), false)).toBe(true);
    for (const type of ['text', 'search', 'number', 'url', 'email', '']) {
      expect(browserMenuWanted(el('INPUT', { type }), false)).toBe(true);
    }
  });

  it('stays shut on inputs nothing is typed into', () => {
    for (const type of ['range', 'checkbox', 'radio', 'color', 'file', 'button']) {
      expect(browserMenuWanted(el('INPUT', { type }), false)).toBe(false);
    }
  });

  it('opens on a link, and on words that are selected', () => {
    expect(browserMenuWanted(el('SPAN', { inLink: true }), false)).toBe(true);
    expect(browserMenuWanted(el('DIV'), true)).toBe(true);
  });
});

describe('a press that asks for the menu', () => {
  const press = (button: number, ctrlKey = false, pointerType = 'mouse') => ({ button, ctrlKey, pointerType });

  it('is the right button anywhere', () => {
    expect(isMenuPress(press(2), false)).toBe(true);
    expect(isMenuPress(press(2), true)).toBe(true);
  });

  it('is Control-click on a Mac, and only there', () => {
    expect(isMenuPress(press(0, true), true)).toBe(true);
    expect(isMenuPress(press(0, true), false)).toBe(false);
  });

  it('is never a plain click, nor a finger with Control held on a keyboard', () => {
    expect(isMenuPress(press(0), true)).toBe(false);
    expect(isMenuPress(press(0, true, 'touch'), true)).toBe(false);
    expect(isMenuPress(press(1, true), true)).toBe(false);
  });
});
