import { describe, expect, it } from 'vitest';
import { parseReportArgs, titleOf } from './report-command.ts';

describe('/bug and /feature', () => {
  it('reads the flags out of the text', () => {
    expect(parseReportArgs('--chat The model stops --no-diagnostics after a tool call')).toEqual({ text: 'The model stops  after a tool call', chat: true, diagnostics: false });
    expect(parseReportArgs('Search in PDFs --diagnostics')).toEqual({ text: 'Search in PDFs', chat: false, diagnostics: true });
    // A flag inside a word is text.
    expect(parseReportArgs('use --chatty mode').chat).toBe(false);
  });

  it('takes the first sentence as the title', () => {
    expect(titleOf('The model stops after a tool call. It happens every time with qwen3.')).toBe('The model stops after a tool call.');
    expect(titleOf('Short one\nMore detail on the next line')).toBe('Short one');
    expect(titleOf('x'.repeat(200))).toHaveLength(118);
  });
});
