import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RpcError, RunnerErrorCode, type Part } from '@atelier/protocol';
import { attachmentName, numbered, placeAttachments } from './attachments.ts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** A folder in memory, written the way the runner writes: `expectSha256` "" for new files only, a hash for that file only. */
function folder(files = new Map<string, Uint8Array>()) {
  const runner = {
    call: async (method: string, params: { path: string; content: string; encoding: 'utf8' | 'base64'; expectSha256?: string }) => {
      if (method !== 'fs.write') throw new Error(`unexpected ${method}`);
      const bytes = params.encoding === 'base64' ? Buffer.from(params.content, 'base64') : Buffer.from(params.content, 'utf8');
      const there = files.get(params.path);
      if (params.expectSha256 === '' && there) throw new RpcError(RunnerErrorCode.Conflict, 'exists');
      if (params.expectSha256 && (!there || sha(there) !== params.expectSha256)) throw new RpcError(RunnerErrorCode.Conflict, 'changed');
      files.set(params.path, new Uint8Array(bytes));
      return { created: !there };
    },
    on: () => () => undefined,
  };
  return { runner: runner as never, files };
}

const blobs = new Map<string, Uint8Array>();
const blob = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  blobs.set(sha(bytes), bytes);
  return sha(bytes);
};
const read = async (id: string) => blobs.get(id)!;
const zip = (name: string, content: string): Part => ({ type: 'document', mime: 'application/zip', blob: blob(content), name });

describe('attached files in the folder', () => {
  it('puts them in a scratch folder’s root', async () => {
    const f = folder();
    const parts = await placeAttachments(f, { scratch: true, read }, [zip('rack.zip', 'PK…'), { type: 'text', text: 'extract this' }]);
    expect(parts[0]).toMatchObject({ type: 'document', name: 'rack.zip', path: 'rack.zip' });
    expect(parts[1]).toEqual({ type: 'text', text: 'extract this' });
    expect(new TextDecoder().decode(f.files.get('rack.zip'))).toBe('PK…');
  });

  it('puts them under .atelier/attachments in a project, which git leaves alone', async () => {
    const f = folder();
    const [part] = await placeAttachments(f, { scratch: false, read }, [zip('rack.zip', 'PK…')]);
    expect(part).toMatchObject({ path: '.atelier/attachments/rack.zip' });
    expect(new TextDecoder().decode(f.files.get('.atelier/attachments/.gitignore'))).toBe('*\n');
  });

  it('numbers a name another file has, and keeps the place of the same file sent again', async () => {
    const f = folder(new Map([['rack.zip', new TextEncoder().encode('another file')]]));
    const [first] = await placeAttachments(f, { scratch: true, read }, [zip('rack.zip', 'PK one')]);
    expect(first).toMatchObject({ path: 'rack (2).zip' });
    const [again] = await placeAttachments(f, { scratch: true, read }, [zip('rack.zip', 'PK one')]);
    expect(again).toMatchObject({ path: 'rack (2).zip' });
    expect(new TextDecoder().decode(f.files.get('rack.zip'))).toBe('another file');
  });

  it('leaves parts that have a place already, and a file it can’t write keeps none', async () => {
    const f = folder();
    const placed: Part = { type: 'document', mime: 'text/csv', blob: blob('a,b'), name: 'x.csv', path: 'x.csv' };
    const failing = { runner: { call: async () => Promise.reject(new Error('disk full')), on: () => () => undefined } as never };
    const errors: string[] = [];
    const [kept] = await placeAttachments(f, { scratch: true, read }, [placed]);
    expect(kept).toBe(placed);
    const [unplaced] = await placeAttachments(failing, { scratch: true, read, onError: (name) => errors.push(name) }, [zip('rack.zip', 'PK')]);
    expect(unplaced).not.toHaveProperty('path');
    expect(errors).toEqual(['rack.zip']);
  });

  it('writes only a plain file name', () => {
    expect(attachmentName('../../etc/passwd')).toBe('passwd');
    expect(attachmentName('C:\\Users\\ada\\model.f3d')).toBe('model.f3d');
    expect(attachmentName('what?.zip')).toBe('what_.zip');
    expect(attachmentName('..')).toBe('attachment');
    expect(attachmentName('.env')).toBe('.env');
    expect(attachmentName(' notes.txt. ')).toBe('notes.txt');
    expect(numbered('rack.zip', 3)).toBe('rack (3).zip');
    expect(numbered('Makefile', 2)).toBe('Makefile (2)');
  });
});
