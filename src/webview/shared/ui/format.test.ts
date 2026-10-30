// Unit tests for format.ts (run: node scripts/build.mjs --test && node --test dist-test/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setFormatLocale, formatPrettyDateTime, formatDateTime, formatRelative, formatSize, pluralize, plural,
  formatShortcut, formatPrettyDate, shortHash,
} from './format';

const sec = (d: Date) => d.getTime() / 1000;

test('pretty date/time with id-ID separators', () => {
  setFormatLocale('id-ID');
  const now = new Date(2026, 9, 29, 15, 0);
  assert.equal(formatPrettyDateTime(sec(new Date(2026, 9, 29, 11, 19)), now), 'Today 11.19');
  assert.equal(formatPrettyDateTime(sec(new Date(2026, 9, 28, 14, 53)), now), 'Yesterday 14.53');
  assert.equal(formatPrettyDateTime(sec(new Date(2026, 9, 27, 10, 27)), now), '27/10/26, 10.27');
  assert.equal(formatPrettyDateTime(sec(new Date(2026, 9, 29, 14, 55)), now), '5 minutes ago');
  assert.equal(formatPrettyDateTime(sec(new Date(2026, 9, 29, 14, 59, 30)), now), 'Moments ago');
  assert.equal(formatPrettyDateTime(new Date(2026, 9, 29, 13, 0), now), 'Today 13.00');
  assert.equal(formatDateTime(new Date(2026, 0, 2, 3, 4)), '02/01/26, 03.04');
  assert.equal(formatPrettyDate(new Date(2026, 9, 28, 1), now), 'Yesterday');
});

test('pretty date/time en-US', () => {
  setFormatLocale('en-US');
  const now = new Date(2026, 9, 29, 15, 0);
  assert.equal(formatPrettyDateTime(new Date(2026, 9, 27, 10, 27), now), '10/27/26, 10:27 AM');
  setFormatLocale(undefined);
});

test('yesterday across month boundary', () => {
  setFormatLocale('id-ID');
  const now = new Date(2026, 10, 1, 9, 0);
  assert.equal(formatPrettyDateTime(new Date(2026, 9, 31, 23, 0), now), 'Yesterday 23.00');
});

test('relative', () => {
  const now = new Date(2026, 9, 29, 15, 0);
  assert.equal(formatRelative(new Date(now.getTime() - 5 * 60_000), now), '5 minutes ago');
  assert.equal(formatRelative(new Date(now.getTime() - 3600_000), now), '1 hour ago');
  assert.equal(formatRelative(new Date(now.getTime() - 3 * 86400_000), now), '3 days ago');
  assert.equal(formatRelative(new Date(now.getTime() - 400 * 86400_000), now), '1 year ago');
  assert.equal(formatRelative(new Date(now.getTime() + 2 * 3600_000), now), 'in 2 hours');
  assert.equal(formatRelative(now, now), 'Moments ago');
});

test('size', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 kB');
  assert.equal(formatSize(1024 * 1024 * 12.34), '12.3 MB');
});

test('plurals', () => {
  assert.equal(pluralize(11, 'file'), '11 files');
  assert.equal(pluralize(1, 'file'), '1 file');
  assert.equal(pluralize(2, 'branch'), '2 branches');
  assert.equal(pluralize(3, 'directory'), '3 directories');
  assert.equal(pluralize(2, 'child', 'children'), '2 children');
  assert.equal(plural('commit', 0), 'commits');
  assert.equal(shortHash('0123456789abcdef'), '01234567');
});

test('shortcuts', () => {
  assert.equal(formatShortcut('CmdOrCtrl+Alt+K', true), '⌥⌘K');
  assert.equal(formatShortcut('CmdOrCtrl+Alt+K', false), 'Ctrl+Alt+K');
  assert.equal(formatShortcut('Shift+CmdOrCtrl+Z', true), '⇧⌘Z');
  assert.equal(formatShortcut('Shift+F10', false), 'Shift+F10');
  assert.equal(formatShortcut('Ctrl+Shift+Enter', true), '⌃⇧↩');
});
