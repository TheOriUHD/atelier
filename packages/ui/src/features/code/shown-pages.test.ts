import { describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { previewsIn } from './shown-pages.ts';

const message = (id: string, role: Message['role'], parts: Message['parts']): Message => ({ id, sessionId: 's', parentId: null, role, parts, model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 });
const call = (id: string, page: string) => message(`a-${id}`, 'assistant', [{ type: 'tool_call', id, name: 'Preview', input: { page } }]);
const result = (id: string, text: string, isError = false) => message(`t-${id}`, 'tool', [{ type: 'tool_result', callId: id, content: [{ type: 'text', text }], ...(isError ? { isError } : {}) }]);

describe('pages the assistant opened', () => {
  it('are the successful Preview calls, each with the file or address it opened', () => {
    const messages = [
      call('1', 'site'),
      result('1', 'Opened site/index.html in the browser pane beside the conversation, with the files beside it as they are on disk.'),
      call('2', 'nope.html'),
      result('2', "Couldn't open nope.html: no such file", true),
      call('3', 'localhost:5173'),
      result('3', 'Opened http://localhost:5173/ in the browser pane beside the conversation.'),
      // Still running: nothing yet.
      call('4', 'about.html'),
    ];
    expect(previewsIn(messages)).toEqual([
      { id: '1', target: { kind: 'file', path: 'site/index.html' } },
      { id: '3', target: { kind: 'url', url: 'http://localhost:5173/' } },
    ]);
  });
});
