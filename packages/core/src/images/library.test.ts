import { describe, expect, it } from 'vitest';
import { openDatabase } from '../store/db.ts';
import { generatedImages, sessions, users } from '../store/schema.ts';
import { generatedImagesFor } from './library.ts';

async function library() {
  const db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'ada', username: 'ada', name: 'ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  await db.insert(sessions).values({ id: 'code-1', userId: 'ada', mode: 'code', title: 'Hero image', createdAt: 0, updatedAt: 0 });
  let n = 0;
  const image = (createdAt: number, extra: Partial<typeof generatedImages.$inferInsert> = {}) =>
    db.insert(generatedImages).values({
      id: `g${n}`,
      userId: 'ada',
      sessionId: 'code-1',
      blob: String(n++).padStart(64, '0'),
      mime: 'image/png',
      size: 1000,
      width: 64,
      height: 64,
      prompt: 'a lighthouse',
      providerId: 'img',
      modelId: 'm',
      modelName: 'M',
      params: {},
      createdAt,
      ...extra,
    });
  return { db, image };
}

describe('the image library', () => {
  it('says which page each image’s conversation opens on', async () => {
    const { db, image } = await library();
    await image(1);
    expect(generatedImagesFor(db, 'ada', { limit: 10 }).items[0]).toMatchObject({ sessionId: 'code-1', sessionTitle: 'Hero image', sessionMode: 'code' });
  });

  it('pages through every image of a batch stored in the same millisecond', async () => {
    const { db, image } = await library();
    for (const at of [50, 40, 40, 40, 30]) await image(at);
    const first = generatedImagesFor(db, 'ada', { limit: 2 });
    expect(first.items.map((i) => i.createdAt)).toEqual([50, 40, 40, 40]);
    expect(first.next).toBe(40);
    const second = generatedImagesFor(db, 'ada', { limit: 2, before: first.next! });
    expect(second.items.map((i) => i.createdAt)).toEqual([30]);
    expect(second.next).toBeNull();
  });

  it('keeps temporary chats’ images out and counts the size of the rest', async () => {
    const { db, image } = await library();
    await image(1);
    await image(2, { hidden: true });
    expect(generatedImagesFor(db, 'ada', { limit: 10 })).toMatchObject({ totalBytes: 1000, items: [{ createdAt: 1 }] });
  });

  it('lists clips with their length, in the same page as pictures, and filters by kind', async () => {
    const { db, image } = await library();
    await image(1);
    await image(2, { kind: 'video', mime: 'video/mp4', mediaSeconds: 6, fps: 24, audio: true, width: 1280, height: 720 });
    const all = generatedImagesFor(db, 'ada', { limit: 10 }).items;
    expect(all.map((i) => i.kind)).toEqual(['video', undefined]);
    expect(all[0]).toMatchObject({ id: expect.stringMatching(/^vid_[0-9a-f]{8}$/), seconds: 6, fps: 24, audio: true, mime: 'video/mp4' });
    expect(all[1]!.id).toMatch(/^img_/);
    expect(generatedImagesFor(db, 'ada', { limit: 10, kind: 'video' }).items).toHaveLength(1);
    expect(generatedImagesFor(db, 'ada', { limit: 10, kind: 'image' }).items.map((i) => i.createdAt)).toEqual([1]);
  });

  it('lists a sound with what it is, its voice and its words, and filters by kind', async () => {
    const { db, image } = await library();
    await image(1);
    await image(2, { kind: 'audio', mime: 'audio/mpeg', width: 0, height: 0, mediaSeconds: 3.5, prompt: 'Hello there', params: { audioKind: 'speech', voice: 'v2', voiceName: 'Bella', direction: 'warm' } });
    await image(3, { kind: 'audio', mime: 'audio/mpeg', width: 0, height: 0, prompt: 'lofi', params: { audioKind: 'music', lyrics: 'la la', speakers: undefined } });
    const sounds = generatedImagesFor(db, 'ada', { limit: 10, kind: 'audio' }).items;
    expect(sounds.map((s) => s.prompt)).toEqual(['lofi', 'Hello there']);
    expect(sounds[1]).toMatchObject({ id: `aud_${'1'.padStart(64, '0').slice(0, 8)}`, kind: 'audio', audioKind: 'speech', seconds: 3.5, voice: 'Bella', direction: 'warm' });
    expect(sounds[0]).toMatchObject({ audioKind: 'music', lyrics: 'la la' });
    expect(generatedImagesFor(db, 'ada', { limit: 10, kind: 'image' }).items).toHaveLength(1);
  });

  it('names a conversation’s voices by speaker', async () => {
    const { db, image } = await library();
    await image(1, { kind: 'audio', mime: 'audio/mpeg', width: 0, height: 0, params: { audioKind: 'speech', speakers: [{ name: 'Ann', voice: 'Kore' }, { name: 'Bo', voice: 'Puck' }] } });
    expect(generatedImagesFor(db, 'ada', { limit: 10 }).items[0]!.voice).toBe('Ann: Kore, Bo: Puck');
  });
});
