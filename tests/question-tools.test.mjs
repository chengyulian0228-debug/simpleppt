import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionPrompt, questionPageText } from '../src/question-tools.ts';

test('copying a legal question preserves conditions and separates supplied reference material', () => {
  const question = '甲于2026年11月1日发出要约，金额为10,000元；乙未在30日内承诺，但存在例外。\nA.成立 B.不成立';
  const context = '教师原文：须区分合同成立与合同生效。';
  const prompt = buildQuestionPrompt(question, context);
  assert.ok(prompt.includes(question));
  assert.ok(prompt.includes(`【课件参考材料】\n${context}`));
  assert.ok(prompt.includes('争议焦点 → 适用规则 → 结合事实分析 → 结论'));
  assert.ok(prompt.includes('不编造法条'));
  assert.throws(() => buildQuestionPrompt(' \n '));
});

test('hint mode waits for the learner and does not request the full answer', () => {
  const prompt = buildQuestionPrompt('这道题如何判断？', '', 'hint');
  assert.ok(prompt.includes('等待我的回答'));
  assert.ok(prompt.includes('暂时不要公布答案'));
  assert.ok(!prompt.includes('最终答案'));
  assert.ok(!prompt.includes('【课件参考材料】'));
});

test('positioned PDF fragments retain numbers, negative words, option order and English word boundaries', () => {
  const spans = [
    { str: 'B.不成立', x: 10, y: 60, size: 12, width: 60 },
    { str: 'here', x: 40, y: 100, size: 12, width: 25 },
    { str: 'now', x: 10, y: 100, size: 12, width: 22 },
    { str: 'A.30日内', x: 10, y: 80, size: 12, width: 50 },
    { str: '未', x: 60, y: 80, size: 12, width: 12 },
    { str: '承诺', x: 72, y: 80, size: 12, width: 24 },
  ];
  assert.equal(questionPageText(spans), 'now here\nA.30日内未承诺\nB.不成立');
  assert.deepEqual(spans[0].str, 'B.不成立');
  assert.equal(questionPageText([]), '');
});
