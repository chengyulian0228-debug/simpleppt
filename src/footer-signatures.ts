import { fingerprint, headingRank } from './structure.ts';

export type FooterLine = { text: string; x: number; right: number; top: number; bottom: number; size: number };
export type FooterPage = { number: number; width: number; height: number; rows: FooterLine[] };
const surnames = '赵钱孙李周吴郑王冯陈卫蒋沈韩杨朱秦许何吕张孔曹严华金魏陶姜谢邹柏苏潘葛范彭鲁韦马方俞任袁柳史唐费薛雷贺倪汤殷罗毕郝安常于傅齐康伍余顾孟黄萧尹姚邵汪毛戴宋熊舒屈项祝董梁杜阮贾路江童颜郭梅盛林钟徐邱骆高夏蔡田胡霍万柯管卢莫丁邓洪包石崔龚程陆翁段焦侯宁仇龙叶白赖乔党谭申牛尚温庄阎向古易廖耿文聂辛曾关查游欧司尉诸上慕南夏皇长闻公东方';
const placeholderNames = new Set(['张三', '李四', '王五', '赵六', '张某', '李某', '王某', '甲方', '乙方']);

function looksLikeSignature(raw: string) {
  const text = fingerprint(raw);
  if (text.length < 2 || text.length > 40 || headingRank(text) || /[。；;！？!?《》]|第\d+条/.test(text)) return false;
  if (/(?:主讲|授课|讲师|讲授|整理|编著|版权所有|版权|公众号|微信|微博|出品|©|®|™)/.test(text)) return true;
  const name = text.replace(/(?:老师|教授|博士)$/, '');
  return /^[\u3400-\u9fff]{2,4}$/.test(name) && surnames.includes(name[0]) && !placeholderNames.has(name);
}

/** Detect repeated, small, isolated signatures at the bottom of different pages. */
export function repeatedFooterSignatures(pages: FooterPage[]) {
  const candidates = new Map<string, { page: FooterPage; line: FooterLine }[]>();
  for (const page of pages) {
    const sizes = page.rows.filter(r => r.top > page.height * .16 && r.bottom < page.height * .86).map(r => r.size).sort((a, b) => a - b);
    const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : page.height * .035;
    for (const line of page.rows) {
      if (line.top < page.height * .9 || line.right - line.x > page.width * .4 || !looksLikeSignature(line.text)) continue;
      if (line.size > Math.max(bodySize * .85, page.height * .027)) continue;
      // A name inside a case, a diagram, or a sentence is not a running signature.
      if (page.rows.some(other => other !== line && other.top < line.bottom + line.size && other.bottom > line.top - line.size * 1.4)) continue;
      const key = fingerprint(line.text);
      const matches = candidates.get(key) || [];
      matches.push({ page, line }); candidates.set(key, matches);
    }
  }
  const result = new Map<number, FooterLine[]>();
  for (const matches of candidates.values()) {
    for (const match of matches) {
      const stable = matches.filter(other => Math.abs(other.line.top / other.page.height - match.line.top / match.page.height) < .025);
      if (new Set(stable.map(other => other.page.number)).size < 2) continue;
      const lines = result.get(match.page.number) || [];
      lines.push(match.line); result.set(match.page.number, lines);
    }
  }
  return result;
}
