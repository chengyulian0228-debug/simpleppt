import test from 'node:test';
import assert from 'node:assert/strict';
import { visualVerdict } from '../src/vision-policy.ts';
import { classifyImages } from '../src/image-policy.ts';
const scores = (kind, score = .94) => ({ scores: [{ kind, score }, { kind: kind === 'chart' ? 'photo' : 'chart', score: 1 - score }] });
const page = (visual, extras = {}, rows = []) => ({ number: 1, width: 960, height: 540, images: [{ operation: 8, x: 600, right: 900, top: 200, bottom: 400, visual, ...extras }], rows });
test('a clear decoration verdict removes ordinary body cartoons/photos, not just corners', () => {
  for (const kind of ['cartoon', 'photo', 'branding']) assert.equal(classifyImages([page(scores(kind))]).get(1)[0].remove, true);
});
test('scientific images, text screenshots, diagrams, question images and uncertainty stay', () => {
  for (const kind of ['diagram', 'chart', 'text', 'question', 'evidence']) assert.equal(visualVerdict(scores(kind)).remove, false);
  assert.equal(visualVerdict(scores('photo', .55)).remove, false);
  assert.equal(visualVerdict({ scores: [] }).remove, false);
});
test('visual scores cannot override captions, text overlays, masks or a whole scanned slide', () => {
  const caption = { text: '图1：实验装置示意', x: 600, right: 900, top: 410, bottom: 430 };
  const overlay = { text: '知识标注', x: 650, right: 750, top: 250, bottom: 275 };
  for (const p of [page(scores('cartoon'), {}, [caption]), page(scores('photo'), {}, [overlay]), page(scores('branding'), { mask: true }), page(scores('photo'), { x: 0, right: 960, top: 0, bottom: 540 })]) assert.equal(classifyImages([p]).get(1)[0].remove, false);
});
