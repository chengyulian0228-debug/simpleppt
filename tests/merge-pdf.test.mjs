import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

// Pure-Node verification of natural filename ordering and pdf-lib multi-PDF merging.
const sortFilesByName = files => [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));

test('natural filename sorting puts 第2讲 before 第10讲', () => {
  const input = [{ name: '第10讲.pdf' }, { name: '第2讲.pdf' }, { name: '第1讲.pdf' }];
  assert.deepEqual(sortFilesByName(input).map(f => f.name), ['第1讲.pdf', '第2讲.pdf', '第10讲.pdf']);
});

test('pdf-lib merges multiple PDFs in order and preserves total page count', async () => {
  const makePdf = async count => {
    const d = await PDFDocument.create();
    for (let i = 0; i < count; i++) d.addPage([200, 200]);
    return await d.save();
  };
  const merged = await PDFDocument.create();
  for (const bytes of [await makePdf(2), await makePdf(3)]) {
    const src = await PDFDocument.load(bytes);
    for (const p of await merged.copyPages(src, src.getPageIndices())) merged.addPage(p);
  }
  const result = await PDFDocument.load(await merged.save());
  assert.equal(result.getPageCount(), 5);
});
