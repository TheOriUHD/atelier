import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cardComputer, useComputerHere } from './computer.ts';

// The desktop app on the Mac, signed in to a server.
vi.mock('./platform.ts', () => ({ desktop: { computer: {}, device: { id: 'mac', name: 'MacBook', platform: 'darwin' } } }));
vi.mock('./lending.ts', () => ({ useConnection: () => ({ data: { mode: 'server', serverUrl: 'https://atelier.example' } }) }));

const pc = { computer: { deviceId: 'pc', name: 'Gaming PC' } };

describe('where a computer use card can be allowed', () => {
  it("is this desktop app for a card of its own computer's, or one that names none", () => {
    expect(renderHook(() => useComputerHere({ computer: { deviceId: 'mac', name: 'MacBook' } })).result.current).toBe('https://atelier.example');
    expect(renderHook(() => useComputerHere({ apps: [] })).result.current).toBe('https://atelier.example');
  });

  it('is never this one for a card of another computer (Remote Control: the session runs there)', () => {
    expect(renderHook(() => useComputerHere(pc)).result.current).toBeNull();
    expect(cardComputer(pc)).toEqual({ deviceId: 'pc', name: 'Gaming PC' });
    expect(cardComputer({ computer: { deviceId: 1 } })).toBeNull();
  });
});
