import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, fingerprint, headingRank, selectPages } from '../src/structure.ts';
test('progressive explanations reopen the matching topic while preserving exceptions', () => {
  const t = new Structure();
  for (const page of [1, 2]) {
    t.heading('第一章 合同', 2, page); t.heading('一、性质', 4, page); t.heading('1.法律行为', 6, page);
    t.block({ kind: 'paragraph', runs: [{ text: '须在30日内完成，但例外情形除外。' }], pages: [page] });
    if (page === 1) { t.heading('2.约束力', 6, page); t.block({ kind: 'paragraph', runs: [{ text: '须依法履行。' }], pages: [page] }); }
    else t.block({ kind: 'paragraph', runs: [{ text: '事实行为的补充解释。' }], pages: [page] });
  }
  const nodes = t.root.children[0].children[0].children;
  assert.equal(nodes.length, 2); assert.equal(nodes[0].body.length, 2);
  assert.equal(nodes[0].body[1].runs[0].text, '事实行为的补充解释。');
  assert.deepEqual(nodes[0].body[0].pages, [1, 2]); assert.equal(t.removedParagraphs, 1);
});
test('identical subsection names in different chapters remain separate', () => {
  const t = new Structure();
  for (const name of ['第一章 成立', '第二章 效力']) { t.heading(name, 2, 1); t.heading('一、条件', 4, 1); t.block({ kind: 'paragraph', runs: [{ text: '相同原文' }], pages: [1] }); }
  assert.equal(t.root.children.length, 2); assert.equal(t.removedParagraphs, 0);
});
test('English word boundaries, legal clauses and page selection stay conservative', () => {
  assert.notEqual(fingerprint('now here'), fingerprint('no where'));
  assert.equal(headingRank('1.当事人应当在30日内履行义务。'), null);
  assert.equal(headingRank('《民法典》第464条'), null);
  assert.deepEqual(selectPages('5-7，7, 81', 574), [5, 6, 7, 81]);
  for (const range of ['0', '4-2', '575', '5,']) assert.throws(() => selectPages(range, 574));
});
