import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedFooterSignatures } from '../src/footer-signatures.ts';
const line = (text, top = 680, size = 14) => ({ text, top, bottom: top + size, size, x: 500, right: 600 });
const page = (number, footer, extra = []) => ({ number, width: 1280, height: 720, rows: [line('合同的成立须结合具体事实判断。', 300, 26), footer, ...extra] });

test('the same small footer signature on different pages is removed from every occurrence', () => {
  const pages = [page(1, line('李夏旭')), page(2, line('李 夏 旭')), page(3, line('李夏旭'))];
  const found = repeatedFooterSignatures(pages);
  assert.deepEqual([...found.keys()], [1, 2, 3]);
  assert.equal(found.get(1)[0].text, '李夏旭');
});

test('names in the body, case placeholders, headings and unique credits are retained', () => {
  assert.equal(repeatedFooterSignatures([page(1, line('王晓明', 300)), page(2, line('王晓明', 300))]).size, 0);
  for (const text of ['张三', '第一章 合同', '甲未承诺，合同不成立。', '《民法典》第464条']) {
    assert.equal(repeatedFooterSignatures([page(1, line(text)), page(2, line(text))]).size, 0);
  }
  assert.equal(repeatedFooterSignatures([page(1, line('王晓明'))]).size, 0);
});

test('a name next to case content is retained, and repeated fragments on one page do not qualify', () => {
  const pages = [page(1, line('王晓明'), [line('原告', 657)]), page(2, line('王晓明'), [line('原告', 657)])];
  assert.equal(repeatedFooterSignatures(pages).size, 0);
  assert.equal(repeatedFooterSignatures([page(1, line('王晓明'), [line('王晓明', 702)])]).size, 0);
});

test('footer branding with explicit attribution text is recognized at a stable bottom position', () => {
  const pages = [page(1, line('主讲：王晓明')), page(2, line('主讲：王晓明'))];
  assert.equal(repeatedFooterSignatures(pages).size, 2);
  const unstable = [page(1, line('王晓明', 650)), page(2, line('王晓明', 696))];
  assert.equal(repeatedFooterSignatures(unstable).size, 0);
});
