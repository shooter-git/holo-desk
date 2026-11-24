import { describe, expect, it } from 'vitest';
import { atEdge, EDGE_PX, isTap } from '../src/app/edge-swipe.ts';

describe('a touch at the side of an iPhone’s screen', () => {
  it('starts at an edge within a finger’s width of either side', () => {
    expect(atEdge(0, 390)).toBe(true);
    expect(atEdge(EDGE_PX - 1, 390)).toBe(true);
    expect(atEdge(EDGE_PX, 390)).toBe(false);
    expect(atEdge(195, 390)).toBe(false);
    expect(atEdge(390 - EDGE_PX, 390)).toBe(false);
    expect(atEdge(390 - EDGE_PX + 1, 390)).toBe(true);
    // on its side the screen is wider, and its sides are where they are
    expect(atEdge(830, 844)).toBe(true);
    expect(atEdge(390, 844)).toBe(false);
  });

  it('is a tap when it hardly moves and doesn’t stay', () => {
    expect(isTap(0, 0, 80)).toBe(true);
    expect(isTap(4, -5, 300)).toBe(true);
    expect(isTap(10, 0, 80)).toBe(false);
    expect(isTap(0, 0, 700)).toBe(false);
  });
});
