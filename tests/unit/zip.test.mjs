// The ZIP archives of the VHDL export: stored entries, the same bytes for the same files, readable again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, unzipStore, zipStore } from '../../assets/composer/js/model/zip.js';

test('CRC-32 of the check string', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('an archive holds the files in their order and is the same for the same files', () => {
  const files = [{ name: 'a.vhd', data: 'library ieee;\n' }, { name: 'b_compile_order.txt', data: 'format composer-compile-order 1\n' }, { name: 'empty.txt', data: '' }];
  const zip = zipStore(files);
  assert.deepEqual(zipStore(files), zip);
  const back = unzipStore(zip);
  assert.deepEqual(back.map((f) => f.name), ['a.vhd', 'b_compile_order.txt', 'empty.txt']);
  assert.equal(new TextDecoder().decode(back[1].data), 'format composer-compile-order 1\n');
  // end of central directory: three entries
  const end = new DataView(zip.buffer, zip.byteOffset + zip.length - 22, 22);
  assert.equal(end.getUint32(0, true), 0x06054b50);
  assert.equal(end.getUint16(10, true), 3);
});
