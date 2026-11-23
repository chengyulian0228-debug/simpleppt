/** Local, evidence-based filtering. Uncertain images remain; this is not a semantic AI classifier. */
import { visualVerdict, type VisualEvidence } from './vision-policy.ts';
export type Box = { x: number; right: number; top: number; bottom: number };
export type ImageRegion = Box & { operation: number; sample?: Uint8Array; mask?: boolean; visual?: VisualEvidence };
export type ImagePage = { number: number; width: number; height: number; rows: (Box & { text: string })[]; images: ImageRegion[] };
export type ImageDecision = { image: ImageRegion; remove: boolean; reason: 'content' | 'template' | 'promotion' | 'decorative' | 'visual' | 'manual' | 'uncertain' };
export const imageKey = (page: number, operation: number) => `${page}:${operation}`;
export const intersects = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
const area = (b: Box) => Math.max(0, b.right - b.x) * Math.max(0, b.bottom - b.top);
const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - b.right, b.x - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
const teaching = /(?:图\s*[0-9一二三四五六七八九十]|表\s*[0-9一二三四五六七八九十]|如图|下图|上图|示意|流程图|流程|结构图|结构|框架|纲要|表格|对比|比较|关系图|坐标|曲线|电路|实验|显微|影像|病例|题图|看图|读图|识图|二维码的|二维码结构|编码原理|figure\s*\d|diagram|chart)/i;
export function countBodyChars(page: ImagePage, isHeadingRow: (row: Box & { text: string }) => boolean): number {
  let total = 0;
  for (const row of page.rows) {
    if (/^\d+$/.test(row.text.trim()) && row.top > page.height * .94) continue;
    if (isHeadingRow(row)) continue;
    total += row.text.replace(/\s+/g, '').length;
  }
  return total;
}
const promotion = /(?:扫码(?:关注|添加|咨询|领取|加群)|扫描.{0,8}(?:关注|领取|加群)|关注.{0,8}(?:公众号|视频号)|添加.{0,6}(?:微信|老师)|微信(?:号|咨询)|课程咨询|商务合作|领取资料|加入.{0,4}群|公众号[：:]|版权所有|\bcopyright\b|[©®™])/i;
function samePicture(a: ImageRegion, b: ImageRegion) {
  if (!a.sample || !b.sample || a.sample.length !== b.sample.length) return false;
  const aspectA = (a.right - a.x) / (a.bottom - a.top), aspectB = (b.right - b.x) / (b.bottom - b.top);
  if (Math.abs(Math.log(aspectA / aspectB)) > .08) return false;
  let difference = 0;
  for (let i = 0; i < a.sample.length; i++) difference += Math.abs(a.sample[i] - b.sample[i]);
  return difference / a.sample.length < 7;
}
function stable(a: ImageRegion, ap: ImagePage, b: ImageRegion, bp: ImagePage) {
  return Math.abs(a.x / ap.width - b.x / bp.width) < .025 && Math.abs(a.top / ap.height - b.top / bp.height) < .025
    && Math.abs((a.right - a.x) / ap.width - (b.right - b.x) / bp.width) < .025
    && Math.abs((a.bottom - a.top) / ap.height - (b.bottom - b.top) / bp.height) < .025;
}
export function classifyImages(pages: ImagePage[]) {
  const all = pages.flatMap(page => page.images.map(image => ({ page, image })));
  const result = new Map<number, ImageDecision[]>();
  for (const page of pages) {
    const decisions = page.images.map((image): ImageDecision => {
      const fraction = area(image) / (page.width * page.height);
      const nearby = page.rows.filter(row => gap(image, row) < page.height * .055);
      const caption = nearby.some(row => teaching.test(row.text));
      const overlap = page.rows.some(row => intersects(image, row));
      // Formula masks and explicitly captioned figures must not be dropped.
      if (image.mask || caption) return { image, remove: false, reason: 'content' };
      const repeats = new Set(all.filter(other => other.page.number !== page.number && stable(image, page, other.image, other.page) && samePicture(image, other.image)).map(other => other.page.number)).size;
      // Slide master backgrounds, logos and banners repeating at the exact same position across >= 3 pages are template decoration.
      if (repeats >= 2) return { image, remove: true, reason: 'template' };
      if (fraction > .85 || overlap) return { image, remove: false, reason: 'content' };
      const edge = image.bottom <= page.height * .22 || image.top >= page.height * .84
        || ((image.right <= page.width * .17 || image.x >= page.width * .83) && image.bottom - image.top <= page.height * .35);
      const promotional = nearby.some(row => promotion.test(row.text));
      const educational = page.rows.some(row => teaching.test(row.text));
      if (promotional && fraction < .18 && !educational) return { image, remove: true, reason: 'promotion' };
      if (edge && fraction < .12 && repeats >= 1) return { image, remove: true, reason: 'template' };
      // A unique small corner badge is decoration only when substantial readable body text exists.
      const corner = (image.right <= page.width * .2 || image.x >= page.width * .8)
        && (image.bottom <= page.height * .15 || image.top >= page.height * .9);
      const bodyText = page.rows.filter(row => row.top > page.height * .2 && row.bottom < page.height * .85).map(row => row.text).join('');
      if (corner && fraction < .008 && bodyText.length > 100) return { image, remove: true, reason: 'template' };
      if (image.visual) {
        const verdict = visualVerdict(image.visual);
        if (verdict.remove) return { image, remove: true, reason: 'visual' };
        return { image, remove: false, reason: 'uncertain' };
      }
      // Concise default: hide uncaptioned standalone body illustrations; users can restore any image in Image Review.
      return { image, remove: true, reason: 'decorative' };
    });
    // PDF.js can paint several images in one operation. Never suppress a whole group if one must remain.
    for (const decision of decisions) if (decision.remove && decisions.some(other => other.image.operation === decision.image.operation && !other.remove)) {
      decision.remove = false; decision.reason = 'uncertain';
    }
    result.set(page.number, decisions);
  }
  return result;
}
