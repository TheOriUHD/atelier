import { describe, expect, it } from 'vitest';
import { computerDeviceFor } from './computer-device.ts';

const all = () => true;

describe('computer use on a server', () => {
  it("is the computer a session's folder is on, whichever device it is written from (Remote Control)", () => {
    expect(computerDeviceFor({ folderDevice: 'pc', lastInSession: 'mac', lastAnywhere: 'mac', devices: ['mac', 'pc'], lends: all })).toBe('pc');
  });

  it("is none while that computer doesn't lend computer use: never the one the person writes from", () => {
    expect(computerDeviceFor({ folderDevice: 'pc', lastInSession: 'mac', lastAnywhere: 'mac', devices: ['mac', 'pc'], lends: (id) => id === 'mac' })).toBeNull();
  });

  it('follows the person for a session that runs on the server: in it, else anywhere, else the first that lends it', () => {
    const lends = (id: string) => id !== 'off';
    expect(computerDeviceFor({ folderDevice: null, lastInSession: 'mac', lastAnywhere: 'pc', devices: ['pc', 'mac'], lends })).toBe('mac');
    expect(computerDeviceFor({ folderDevice: null, lastInSession: 'off', lastAnywhere: 'pc', devices: ['mac', 'pc'], lends })).toBe('pc');
    expect(computerDeviceFor({ folderDevice: null, lastInSession: undefined, lastAnywhere: undefined, devices: ['off', 'mac'], lends })).toBe('mac');
    expect(computerDeviceFor({ folderDevice: null, lastInSession: undefined, lastAnywhere: undefined, devices: ['off'], lends })).toBeNull();
  });
});
