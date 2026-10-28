import { describe, expect, it } from 'vitest';
import { dateFormat } from '../php-compat/date';

describe('PHP date format compatibility', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [11, '11th'], [12, '12th'],
    [13, '13th'], [21, '21st'], [22, '22nd'], [23, '23rd'], [28, '28th'],
  ])('formats the %d ordinal day as %s', (day, expected) => {
    expect(dateFormat(Date.UTC(2026, 9, day) / 1000, 'jS')).toBe(expected);
  });

  it('respects site timezone for ISO, RFC, and offset specifiers', () => {
    const timestamp = Date.UTC(2026, 9, 28, 8, 2, 3) / 1000;
    expect(dateFormat(timestamp, 'F jS, Y \\a\\t h:ia O P', 28800)).toBe('October 28th, 2026 at 04:02pm +0800 +08:00');
    expect(dateFormat(timestamp, 'c', 28800)).toBe('2026-10-28T16:02:03+08:00');
    expect(dateFormat(timestamp, 'r', 28800)).toBe('Wed, 28 Oct 2026 16:02:03 +0800');
  });
});
