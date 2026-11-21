import { describe, expect, it } from 'vitest';
import { browserDetail } from './computer-use-section.tsx';

describe('the browser extension row', () => {
  it('says which browser is connected, and the others with which one Atelier uses', () => {
    expect(browserDetail({ connected: false })).toBeUndefined();
    expect(browserDetail({ connected: true, browser: 'Firefox 158' })).toBe('Connected in Firefox 158');
    expect(browserDetail({ connected: true, browser: 'Firefox 158', others: [{ browser: 'Google Chrome 142' }] })).toBe(
      'Connected in Firefox 158, and in Google Chrome 142: Atelier works in the browser you used last, and a chat’s tabs stay where they are',
    );
  });
});
