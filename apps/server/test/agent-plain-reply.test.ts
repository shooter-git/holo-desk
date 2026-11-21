import { describe, expect, it } from 'vitest';
import { plainReply } from '../src/agent/plain.ts';

describe('a harness’s last words, made plain for the bar', () => {
  it('drops inline markup and keeps the words', () => {
    expect(
      plainReply(
        '**Short answer:** they mostly work. The audio sides are `take_*.wav` files, turned *inactive* on purpose; see [the mixer](https://example.com) and ~~not~~ the __bass__.',
      ),
    ).toBe(
      'Short answer: they mostly work. The audio sides are take_*.wav files, turned inactive on purpose; see the mixer and not the bass.',
    );
  });

  it('leaves words with underscores and stars in them alone', () => {
    expect(plainReply('Use snake_case_names, 2*3*4 bars, and an escaped \\*star\\*.')).toBe(
      'Use snake_case_names, 2*3*4 bars, and an escaped *star*.',
    );
    // a bold cut short isn't left hanging
    expect(plainReply('The organ has **no patch')).toBe('The organ has no patch');
  });

  it('keeps a line for each paragraph, heading and list item, and joins a paragraph’s own lines', () => {
    const said = [
      '## What I checked',
      '',
      'Six tracks load their',
      'patches and play.',
      '',
      '- **Bass**: fine',
      '* Lead: 2 dB louder',
      '  than its bounce',
      '1. Organ: no patch',
      '',
      '> The rest is unchanged.',
      '',
      '---',
      '```',
      'notes_write --track 3',
      '```',
    ].join('\n');
    expect(plainReply(said)).toBe(
      [
        'What I checked',
        'Six tracks load their patches and play.',
        '• Bass: fine',
        '• Lead: 2 dB louder than its bounce',
        '1. Organ: no patch',
        'The rest is unchanged.',
        'notes_write --track 3',
      ].join('\n'),
    );
  });

  it('reads a table a row to a line', () => {
    const said = '| Track | Level |\n|---|:---:|\n| Bass | -3 dB |\n| Lead | -5 dB |';
    expect(plainReply(said)).toBe('Track · Level\nBass · -3 dB\nLead · -5 dB');
  });

  it('cuts a long reply at the end of a sentence, else at a word, within the limit', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Track ${i + 1} plays as it should.`).join(' ');
    const cut = plainReply(sentences, 200);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut).toMatch(/should\. …$/);

    const words = Array.from({ length: 80 }, () => 'word').join(' ');
    const byWord = plainReply(words, 100);
    expect(byWord.length).toBeLessThanOrEqual(100);
    expect(byWord).toMatch(/ word…$/);

    expect(plainReply('y'.repeat(900), 600)).toBe(`${'y'.repeat(599)}…`);
  });

  it('turns control characters into spaces and says nothing for markup alone', () => {
    expect(plainReply('Bar\u00073\ttoo\r\nflat')).toBe('Bar 3 too flat');
    expect(plainReply('---\n\n```\n```')).toBe('');
  });
});
