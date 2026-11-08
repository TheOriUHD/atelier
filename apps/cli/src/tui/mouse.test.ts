import { expect, it } from 'vitest';
import { takeWheel } from './mouse.ts';

it('takes the wheel out of what is typed, and keeps a report cut in two for the next read', () => {
  const moves: number[] = [];
  const emit = (n: number) => moves.push(n);
  expect(takeWheel('a\x1b[<64;10;5Mb\x1b[<65;10;5Mc', emit)).toEqual({ rest: 'abc', held: '' });
  expect(moves).toEqual([-3, 3]);
  // Shift held, and a click: the wheel scrolls, the click is dropped, the keys go on.
  expect(takeWheel('\x1b[<68;1;1M\x1b[<0;3;4M\x1b[<0;3;4mx', emit).rest).toBe('x');
  expect(moves).toEqual([-3, 3, -3]);
  const first = takeWheel('hi\x1b[<6', emit);
  expect(first).toEqual({ rest: 'hi', held: '\x1b[<6' });
  expect(takeWheel(`${first.held}5;2;2M!`, emit).rest).toBe('!');
  expect(moves).toEqual([-3, 3, -3, 3]);
  // A lone Esc at the end is a key, not the start of a report.
  expect(takeWheel('\x1b', emit)).toEqual({ rest: '\x1b', held: '' });
});
