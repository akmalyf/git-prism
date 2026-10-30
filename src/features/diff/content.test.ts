// Unit tests for content.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEncode, decode, defaultTitle, detectEol, encode, imageMime, isBinary, languageOf, onlySeparatorNotice, requestKey, shortRev, sideTitles } from './content';

const bytes = (s: string) => new TextEncoder().encode(s);

test('binary detection by NUL byte, UTF-16 with BOM is text', () => {
  assert.equal(isBinary(new Uint8Array([0x50, 0x00, 0x41])), true);
  assert.equal(isBinary(bytes('plain text')), false);
  assert.equal(isBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), false);
});

test('decode normalizes line separators and remembers them', () => {
  const d = decode(bytes('a\r\nb\r\n'));
  assert.equal(d.text, 'a\nb\n');
  assert.deepEqual(d.meta, { encoding: 'utf8', bom: false, eol: '\r\n' });
  assert.equal(detectEol('x\ry'), '\r');
  assert.equal(detectEol('none'), '\n');
});

test('encode round-trips EOL, BOM and UTF-16', () => {
  for (const raw of [bytes('a\r\nb'), new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('é\n')]), new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00])]) {
    const d = decode(raw);
    assert.deepEqual([...encode(d.text!, d.meta)], [...raw]);
  }
  const be = decode(new Uint8Array([0xfe, 0xff, 0x00, 0x62]));
  assert.equal(be.text, 'b');
  assert.deepEqual([...encode('b', be.meta)], [0xfe, 0xff, 0x00, 0x62]);
});

test('notice for differences only in separators/encoding', () => {
  const a = bytes('x\ny\n');
  const b = bytes('x\r\ny\r\n');
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...a]);
  assert.equal(onlySeparatorNotice(decode(a), decode(b), a, b), 'Contents have differences only in line separators');
  assert.equal(onlySeparatorNotice(decode(a), decode(bom), a, bom), 'Contents have differences only in encoding');
  assert.equal(onlySeparatorNotice(decode(a), decode(a), a, a), undefined);
  const c = bytes('z');
  assert.equal(onlySeparatorNotice(decode(a), decode(c), a, c), undefined);
});

test('languages and images', () => {
  assert.equal(languageOf('app/Http/Kernel.php'), 'php');
  assert.equal(languageOf('resources/views/a.blade.php'), 'html');
  assert.equal(languageOf('Dockerfile'), 'dockerfile');
  assert.equal(languageOf('.env.example'), 'ini');
  assert.equal(languageOf('README'), 'plaintext');
  assert.equal(imageMime('logo.PNG'), 'image/png');
  assert.equal(imageMime('icon.svg'), undefined);
});

test('titles', () => {
  const h = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert.equal(shortRev(h), 'a1b2c3d4');
  assert.equal(shortRev('HEAD~1'), 'HEAD~1');
  assert.equal(defaultTitle({ worktree: true, path: 'a' }, 'right'), 'Current version');
  assert.equal(defaultTitle({ index: true, path: 'a' }, 'right'), 'Staged');
  assert.equal(defaultTitle({ rev: h, path: 'a' }, 'left'), 'a1b2c3d4');
  assert.equal(defaultTitle({ empty: true }, 'left'), 'Base version');
  assert.equal(defaultTitle({ empty: true }, 'right'), 'Your version');
  assert.deepEqual(sideTitles({ repoRoot: '/r', path: 'b.txt', left: { rev: 'HEAD', path: 'a.txt' }, right: { worktree: true, path: 'b.txt' } }), {
    left: { title: 'HEAD', path: 'a.txt' },
    right: { title: 'Current version', path: 'b.txt' },
  });
  assert.deepEqual(sideTitles({ repoRoot: '/r', path: 'b', left: { empty: true }, right: { index: true, path: 'b' }, leftTitle: 'HEAD' }), {
    left: { title: 'HEAD', path: undefined },
    right: { title: 'Staged', path: 'b' },
  });
  const f = { repoRoot: '/r', path: 'x', left: { rev: 'HEAD', path: 'x' }, right: { worktree: true as const, path: 'x' } };
  assert.equal(requestKey([f]), requestKey([{ ...f, kind: 'M' }]));
});

test('invalid UTF-8 falls back to windows-1252 and round-trips every byte', () => {
  const d = decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.equal(d.text, 'caf\u00e9\n');
  assert.equal(d.meta.encoding, 'windows1252');
  const all = new Uint8Array(256).map((_, i) => i).filter((b) => b !== 0 && b !== 0x0d && b !== 0x0a);
  const withHigh = new Uint8Array([...all, 0xff]);
  const dd = decode(withHigh);
  assert.equal(dd.meta.encoding, 'windows1252');
  assert.deepEqual([...encode(dd.text!, dd.meta)], [...withHigh]);
  assert.equal(canEncode('\u20ac ok', dd.meta), true);
  assert.equal(canEncode('\u4e2d', dd.meta), false);
  assert.throws(() => encode('\u4e2d', dd.meta));
  assert.equal(canEncode('\u4e2d', decode(bytes('ok')).meta), true);
});
