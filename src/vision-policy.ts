// CLIP scores rank these descriptions; they are not calibrated probabilities of relevance.
export const visualLabels = {
  cartoon: 'a decorative cartoon character, emoji, sticker or reaction meme',
  photo: 'a decorative stock photograph of people, scenery or objects',
  branding: 'an advertisement, promotional poster, brand logo or watermark',
  diagram: 'an educational diagram, flowchart, mind map or technical illustration',
  chart: 'a scientific graph, data chart or table',
  text: 'a screenshot or scanned page of written text, a document or a book',
  question: 'a mathematical equation, geometry problem or exam question',
  evidence: 'an educational reference photograph, historical artifact, scientific or medical image',
};
export type VisualKind = keyof typeof visualLabels;
export type VisualScore = { kind: VisualKind; score: number };
export type VisualEvidence = { scores: VisualScore[] };
export function visualVerdict(evidence: VisualEvidence) {
  const scores = [...evidence.scores].sort((a, b) => b.score - a.score);
  const top = scores[0];
  if (!top) return { remove: false, label: '无法判断' };
  const names: Record<VisualKind, string> = { cartoon: '卡通或表情配图', photo: '普通照片', branding: '标志或推广图', diagram: '知识示意图', chart: '图表', text: '文字截图', question: '题图或公式', evidence: '教学参考图' };
  const protectedScore = scores.filter(s => ['diagram', 'chart', 'text', 'question', 'evidence'].includes(s.kind)).reduce((sum, s) => sum + s.score, 0);
  const decorationScore = scores.filter(s => ['cartoon', 'photo', 'branding'].includes(s.kind)).reduce((sum, s) => sum + s.score, 0);
  // A photograph alone says nothing about its relevance. Require a clear visual margin,
  // protect scientific/reference content, and expose every decision in the image review.
  const remove = ['cartoon', 'photo', 'branding'].includes(top.kind) && decorationScore >= .78
    && top.score >= .5 && top.score - (scores[1]?.score || 0) >= .25 && protectedScore <= .22;
  return { remove, label: names[top.kind] };
}
