import { expect, it } from 'vitest';
import { takeMouse } from './mouse.ts';

it('takes the wheel and clicks out of what is typed, and keeps a report cut in two for the next read', () => {
  const moves: number[] = [];
  const clicks: { x: number; y: number }[] = [];
  const emit = { wheel: (n: number) => moves.push(n), click: (at: { x: number; y: number }) => clicks.push(at) };
  expect(takeMouse('a\x1b[<64;10;5Mb\x1b[<65;10;5Mc', emit)).toEqual({ rest: 'abc', held: '' });
  expect(moves).toEqual([-3, 3]);
  // Shift held, and a click: the wheel scrolls, the click is told once (going down, not coming up), the keys go on.
  expect(takeMouse('\x1b[<68;1;1M\x1b[<0;3;4M\x1b[<0;3;4mx', emit).rest).toBe('x');
  expect(moves).toEqual([-3, 3, -3]);
  expect(clicks).toEqual([{ x: 2, y: 3 }]);
  // The right button and a drag aren't clicks.
  expect(takeMouse('\x1b[<2;3;4M\x1b[<32;3;5M', emit).rest).toBe('');
  expect(clicks).toHaveLength(1);
  const first = takeMouse('hi\x1b[<6', emit);
  expect(first).toEqual({ rest: 'hi', held: '\x1b[<6' });
  expect(takeMouse(`${first.held}5;2;2M!`, emit).rest).toBe('!');
  expect(moves).toEqual([-3, 3, -3, 3]);
  // A lone Esc at the end is a key, not the start of a report.
  expect(takeMouse('\x1b', emit)).toEqual({ rest: '\x1b', held: '' });
});
