import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {unzipSync} from 'fflate';
import {
  StreamingZipBuilder,
  buildUniqueEntryName,
  computeRangeSelection,
  estimateTotalMediaBytes,
  isDownloadableMedia,
  resolveMediaFilename,
} from '../src/lib/media-download.ts';

describe('Media Batch Download & Streaming ZIP Utilities', () => {
  it('filters downloadable media types and excludes links and revoked messages', () => {
    for (const mediaType of ['image', 'video', 'audio', 'document', 'sticker', 'IMAGE']) {
      assert.equal(isDownloadableMedia({media_type: mediaType, is_revoked: false}), true);
    }

    assert.equal(isDownloadableMedia({media_type: 'link', is_revoked: false}), false);
    assert.equal(isDownloadableMedia({media_type: 'url', is_revoked: false}), false);
    assert.equal(isDownloadableMedia({media_type: '', is_revoked: false}), false);
    assert.equal(isDownloadableMedia({media_type: 'image', is_revoked: true}), false);
  });

  it('resolves safe filenames preserving Unicode/Arabic and inferring MIME extensions', () => {
    assert.equal(
      resolveMediaFilename(
        {id: 'm1', media_type: 'document', filename: 'فاتورة يناير.pdf'},
        'application/pdf',
      ),
      'فاتورة يناير.pdf',
    );

    assert.equal(
      resolveMediaFilename(
        {id: 'm2', media_type: 'document', filename: '../../etc/passwd'},
        'text/plain',
      ),
      'passwd.txt',
    );

    assert.equal(
      resolveMediaFilename(
        {id: 'MSG123456789', media_type: 'image', filename: ''},
        'image/webp; charset=utf-8',
      ),
      'image_MSG12345.webp',
    );

    assert.equal(
      resolveMediaFilename({id: 'm3', media_type: 'audio', filename: ''}, undefined),
      'audio_m3.ogg',
    );

    assert.equal(
      resolveMediaFilename(
        {id: 'm4', media_type: 'image', filename: ''},
        'image/jpeg',
        '176391000-photo.jfif',
      ),
      '176391000-photo.jpg',
    );

    assert.equal(
      resolveMediaFilename(
        {id: 'm5', media_type: 'video', filename: ''},
        'video/x-f4v',
        '176391000-clip.f4v',
      ),
      '176391000-clip.mp4',
    );

    assert.equal(
      resolveMediaFilename(
        {id: 'm6', media_type: 'audio', filename: ''},
        'audio/ogg',
        'voice-note.oga',
      ),
      'voice-note.ogg',
    );

    assert.equal(
      resolveMediaFilename(
        {id: 'm7', media_type: 'document', filename: 'legacy-flash.f4v'},
        'application/octet-stream',
      ),
      'legacy-flash.f4v',
    );
  });

  it('deduplicates colliding archive filenames cleanly', () => {
    const used = new Set<string>();
    assert.equal(buildUniqueEntryName('photo.jpg', used), 'photo.jpg');
    assert.equal(buildUniqueEntryName('photo.jpg', used), 'photo (2).jpg');
    assert.equal(buildUniqueEntryName('photo.jpg', used), 'photo (3).jpg');
    assert.equal(buildUniqueEntryName('README', used), 'README');
    assert.equal(buildUniqueEntryName('README', used), 'README (2)');
  });

  it('computes single-toggle and Shift+Click forward/backward range selection', () => {
    const ordered = ['m1', 'm2', 'm3', 'm4', 'm5'];

    // Single click toggles item
    const s1 = computeRangeSelection(ordered, new Set(), null, 'm2', false);
    assert.deepEqual([...s1], ['m2']);

    // Shift+Click forward selects m2..m4
    const s2 = computeRangeSelection(ordered, s1, 'm2', 'm4', true);
    assert.deepEqual([...s2], ['m2', 'm3', 'm4']);

    // Shift+Click backward from m4 to m1 adds m1..m4
    const s3 = computeRangeSelection(ordered, s1, 'm4', 'm1', true);
    assert.deepEqual([...s3], ['m2', 'm1', 'm3', 'm4']);

    // Clicking selected item without Shift deselects only that item
    const s4 = computeRangeSelection(ordered, s2, 'm4', 'm3', false);
    assert.deepEqual([...s4], ['m2', 'm4']);
  });

  it('estimates total bytes safely ignoring invalid file lengths', () => {
    assert.equal(
      estimateTotalMediaBytes([
        {file_length: 1024},
        {file_length: 0},
        {file_length: -5},
        {file_length: Number.NaN},
        {file_length: 2048},
      ]),
      3072,
    );
  });

  it('builds a valid STORE-mode ZIP archive with deduplicated & Arabic filenames', async () => {
    const builder = new StreamingZipBuilder();
    const enc = new TextEncoder();

    const first = builder.add('صورة.jpg', enc.encode('img-bytes-1'));
    const second = builder.add('صورة.jpg', enc.encode('img-bytes-2'));
    const third = builder.add('invoice.pdf', enc.encode('pdf-content'));

    assert.equal(first, 'صورة.jpg');
    assert.equal(second, 'صورة (2).jpg');
    assert.equal(third, 'invoice.pdf');
    assert.equal(builder.count, 3);

    const zipBlob = await builder.finalize();
    assert.equal(zipBlob.type, 'application/zip');

    const extracted = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
    const dec = new TextDecoder();
    assert.equal(dec.decode(extracted['صورة.jpg']), 'img-bytes-1');
    assert.equal(dec.decode(extracted['صورة (2).jpg']), 'img-bytes-2');
    assert.equal(dec.decode(extracted['invoice.pdf']), 'pdf-content');
  });

  it('aborts StreamingZipBuilder cleanly without throwing', () => {
    const builder = new StreamingZipBuilder();
    builder.add('sample.txt', new Uint8Array([1, 2, 3]));
    assert.doesNotThrow(() => builder.abort());
  });
});
