import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyImages } from '../src/image-policy.ts';
const sample = n => new Uint8Array(192).fill(n);
const image = (operation = 1, extras = {}) => ({ operation, x: 860, right: 940, top: 460, bottom: 520, sample: sample(50), ...extras });
const page = (number, images = [image()], rows = []) => ({ number, width: 960, height: 540, images, rows: [{ text: '第一章 课程知识', x: 80, right: 400, top: 20, bottom: 50 }, { text: '正文独有信息和条件须完整保留。', x: 80, right: 700, top: 200, bottom: 230 }, ...rows] });
const decision = pages => [...classifyImages(pages).values()].flat();
test('repeated footer branding and top badges are removed even with different image IDs', () => {
  assert.ok(decision([page(1), page(2, [image(9)])]).every(d => d.remove && d.reason === 'template'));
  assert.ok(decision([page(1, [image(1, { top: 5, bottom: 65 })]), page(2, [image(2, { top: 5, bottom: 65 })])]).every(d => d.remove));
});
test('repeated diagrams in the body, scanned text, equation masks and overlaid labels remain', () => {
  for (const extras of [{ x: 250, right: 650, top: 270, bottom: 440 }, { x: 0, right: 960, top: 0, bottom: 540 }, { mask: true }, { x: 100, right: 300, top: 190, bottom: 240 }]) {
    assert.ok(decision([page(1, [image(1, extras)]), page(2, [image(2, extras)])]).every(d => !d.remove));
  }
});
test('a caption protects a small repeated figure at the page edge', () => {
  const caption = { text: '图1：细胞结构示意', x: 830, right: 955, top: 430, bottom: 450 };
  assert.ok(decision([page(1, [image()], [caption]), page(2, [image()], [caption])]).every(d => !d.remove));
});
test('similar placement or blank samples alone do not establish repeated branding', () => {
  assert.ok(decision([page(1), page(2, [image(1, { sample: sample(180) })])]).every(d => !d.remove));
  assert.ok(decision([page(1, [image(1, { sample: undefined })]), page(2, [image(2, { sample: undefined })])]).every(d => !d.remove));
  assert.ok(decision([page(1, [image(), image(2)])]).every(d => !d.remove));
});
test('promotional QR images can be removed, teaching examples of QR codes stay', () => {
  const promo = { text: '扫码关注公众号', x: 815, right: 955, top: 430, bottom: 450 };
  assert.equal(decision([page(1, [image()], [promo])])[0].reason, 'promotion');
  const teaching = { text: '图1 二维码结构示例', x: 60, right: 450, top: 100, bottom: 130 };
  assert.equal(decision([page(1, [image()], [promo, teaching])])[0].remove, false);
});
test('a tiny isolated corner badge is removed on a single text page, an uncertain body photo stays', () => {
  const body = { text: '这是一段包含独有教学内容的正文。'.repeat(10), x: 80, right: 750, top: 250, bottom: 280 };
  assert.equal(decision([page(1, [image(1, { x: 900, right: 940, top: 10, bottom: 50 })], [body])])[0].remove, true);
  assert.equal(decision([page(1, [image(1, { x: 600, right: 900, top: 290, bottom: 490 })], [body])])[0].remove, false);
});
