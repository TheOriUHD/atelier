import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, UPDATING_ERROR_CODE } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { reportError, updatingError } from './coop.ts';

vi.mock('../../components/ui/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../components/ui/index.ts')>();
  return { ...original, toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) };
});

beforeEach(() => {
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('reportError', () => {
  it('says the server installing an update as a plain notice, not as an error', () => {
    const error = appError(UPDATING_ERROR_CODE, 'Atelier is installing an update right now. Try again in a few seconds.');
    expect(updatingError(error)).toBe(true);
    reportError('s1', error);
    expect(toast.info).toHaveBeenCalledWith('Atelier is installing an update right now. Try again in a few seconds.');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still shows any other failure as an error', () => {
    const error = appError('no_model', 'Add a model provider to start chatting.');
    expect(updatingError(error)).toBe(false);
    reportError('s1', error);
    expect(toast.error).toHaveBeenCalledWith('Add a model provider to start chatting.');
    expect(toast.info).not.toHaveBeenCalled();
    expect(updatingError(new Error('Internal error'))).toBe(false);
  });
});
