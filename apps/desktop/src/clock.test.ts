import { describe, expect, it } from 'vitest';
import {
  localeHourCycle,
  parseShortTime,
  posixLocaleTag,
  shortTimeHourCycle,
  systemHourCycle,
  type ClockSources,
} from './clock.ts';

function sources(overrides: Partial<ClockSources>): ClockSources {
  return {
    platform: 'darwin',
    force24: () => false,
    force12: () => false,
    systemLocale: () => 'en-US',
    country: () => 'US',
    shortTime: async () => null,
    env: {},
    ...overrides,
  };
}

describe("the computer's clock", () => {
  it('reads a locale’s clock', () => {
    expect(localeHourCycle('de-DE')).toBe('h23');
    expect(localeHourCycle('en-US')).toBe('h12');
    expect(localeHourCycle('en-GB')).toBe('h23');
    expect(localeHourCycle('not a tag')).toBeNull();
  });

  it('on macOS, follows the 24-hour switch, then the region', async () => {
    // English with region Germany: the menu bar shows 14:25.
    expect(await systemHourCycle(sources({ systemLocale: () => 'en-US@rg=dezzzz', country: () => 'DE' }))).toBe('h23');
    expect(await systemHourCycle(sources({}))).toBe('h12');
    expect(await systemHourCycle(sources({ force24: () => true }))).toBe('h23');
    expect(
      await systemHourCycle(sources({ systemLocale: () => 'de-DE', country: () => 'DE', force12: () => true })),
    ).toBe('h12');
    expect(await systemHourCycle(sources({ country: () => '' }))).toBeNull();
  });

  it('on Windows, follows the short time format', async () => {
    expect(
      parseShortTime(
        '\r\nHKEY_CURRENT_USER\\Control Panel\\International\r\n    sShortTime    REG_SZ    HH:mm\r\n\r\n',
      ),
    ).toBe('HH:mm');
    expect(parseShortTime('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
    expect(shortTimeHourCycle('h:mm tt')).toBe('h12');
    expect(await systemHourCycle(sources({ platform: 'win32', shortTime: async () => 'HH:mm' }))).toBe('h23');
    expect(await systemHourCycle(sources({ platform: 'win32', shortTime: async () => 'h:mm tt' }))).toBe('h12');
    expect(
      await systemHourCycle(sources({ platform: 'win32', shortTime: () => Promise.reject(new Error('no reg')) })),
    ).toBeNull();
  });

  it('on Linux, follows the time locale', async () => {
    expect(posixLocaleTag('de_DE.UTF-8')).toBe('de-DE');
    expect(posixLocaleTag('C.UTF-8')).toBeNull();
    expect(
      await systemHourCycle(sources({ platform: 'linux', env: { LANG: 'en_US.UTF-8', LC_TIME: 'de_DE.UTF-8' } })),
    ).toBe('h23');
    expect(await systemHourCycle(sources({ platform: 'linux', env: { LANG: 'en_US.UTF-8' } }))).toBe('h12');
    expect(await systemHourCycle(sources({ platform: 'linux', env: { LANG: 'C' } }))).toBeNull();
  });
});
