// Only canonicalize compatibility ideographs and Wingdings/Symbol PUA bullets; never paraphrase content.
const puaBullets: Record<string, string> = { '\uf0d8': '▶', '\uf075': '◆', '\uf070': '▪', '\uf0a7': '▪', '\uf06e': '▪', '\uf0fc': '✓', '\uf0fe': '✓', '\uf0e0': '→', '\uf0f0': '→' };
export const clean = (text: string) => text
  .replace(/[\uf000-\uf0ff]/g, c => puaBullets[c] || '•')
  .replace(/[\u2e80-\u2fdf\uf900-\ufaff]/g, c => c === '⺠' ? '民' : c.normalize('NFKC'))
  .trim();
export const fingerprint = (text: string) => clean(text).replace(/\s+/g, ' ').replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '');
export function selectPages(value: string, count: number): number[] {
  if (!value.trim()) return Array.from({ length: count }, (_, i) => i + 1);
  const selected = new Set<number>();
  for (const part of value.split(/[,，、]/)) {
    const match = part.match(/^\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*$/);
    if (!match) throw new Error('页码格式不正确，请填写如 5-10, 18');
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (!(start >= 1 && start <= end && end <= count)) throw new Error(`页码范围应在 1-${count} 内，起始页不能大于结束页`);
    for (let i = start; i <= end; i++) selected.add(i);
  }
  return [...selected].sort((a, b) => a - b);
}
export function headingRank(raw: string): number | null {
  const text = clean(raw);
  if (text.length > 90) return null;
  if (/^第[一二三四五六七八九十百零〇\d]+[编部]/.test(text)) return 1;
  if (/^第[一二三四五六七八九十百零〇\d]+章/.test(text)) return 2;
  if (/^第[一二三四五六七八九十百零〇\d]+节/.test(text)) return 3;
  // Numbered legal clauses / long statements stay verbatim paragraphs.
  if (text.length > 65 || /[。；;！？!?]/.test(text) || /^\d.*[：:]/.test(text)) return null;
  if (/^[一二三四五六七八九十百]+[、．.]/.test(text)) return 4;
  if (/^[（(][一二三四五六七八九十百]+[）)]/.test(text)) return 5;
  if (/^\d{1,2}[.．、]\s*\D/.test(text)) return 6;
  return null;
}
export type Run = { text: string; red?: boolean; underline?: boolean };
export type Block = { kind: 'paragraph' | 'image'; runs: Run[]; pages: number[]; image?: Uint8Array; width?: number; height?: number };
export type Topic = { text: string; rank: number; body: Block[]; children: Topic[]; pages: Set<number>; seen: Map<string, Block> };
export function topic(text = '', rank = 0): Topic { return { text, rank, body: [], children: [], pages: new Set(), seen: new Map() }; }
export class Structure {
  root = topic(); stack = [this.root]; registry = new Map<string, Topic>();
  removedHeadings = 0; removedParagraphs = 0;
  heading(text: string, rank: number, page: number) {
    while (this.stack.length > 1 && this.stack.at(-1)!.rank >= rank) this.stack.pop();
    const path = JSON.stringify([...this.stack.slice(1).map(n => fingerprint(n.text)), fingerprint(text)]);
    let node = this.registry.get(path);
    if (node) this.removedHeadings++;
    else { node = topic(text, rank); this.registry.set(path, node); this.stack.at(-1)!.children.push(node); }
    node.pages.add(page); this.stack.push(node);
  }
  block(block: Block) {
    const node = this.stack.at(-1)!;
    block.pages.forEach(p => node.pages.add(p));
    const key = fingerprint(block.runs.map(r => r.text).join(''));
    const prior = key && block.kind === 'paragraph' ? node.seen.get(key) : undefined;
    if (prior) {
      this.removedParagraphs++; prior.pages = [...new Set([...prior.pages, ...block.pages])];
      // Progressive slides sometimes add emphasis without changing their words.
      if (prior.runs.map(r => r.text).join('') === block.runs.map(r => r.text).join('')) {
        const expand = (runs: Run[]) => runs.flatMap(r => [...r.text].map(text => ({ ...r, text })));
        const original = expand(prior.runs), added = expand(block.runs);
        prior.runs = original.map((r, i) => ({ text: r.text, red: r.red || added[i].red, underline: r.underline || added[i].underline }));
      }
    }
    else { node.body.push(block); if (key) node.seen.set(key, block); }
  }
}
