import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, PDFName, PDFString, PDFHexString, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { clean, fingerprint, headingRank, selectPages, Structure, type Run, type Topic } from './structure';
import type { Options, Job, SavedImageReview } from './types';
import { questionPageText } from './question-tools';
import { repeatedFooterSignatures, type FooterLine } from './footer-signatures';
import { classifyImages, intersects, imageKey, type ImageRegion, type Box } from './image-policy';
import { inspectVisual, closeVision } from './vision-client';
import { visualVerdict } from './vision-policy';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, document.baseURI).href;
export async function openPdf(blob: Blob): Promise<PDFDocumentProxy> {
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()),
      cMapUrl: asset('pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: asset('pdfjs/standard_fonts/'),
      wasmUrl: asset('pdfjs/wasm/'), isEvalSupported: false }).promise;
  } catch (e) {
    if (e instanceof Error && /password/i.test(e.name + e.message)) throw new Error('这份 PDF 设有密码，请先在本机另存为无密码版本。');
    throw new Error('无法读取这份 PDF，请检查文件是否完整，或重新导出后再试。');
  }
}
export async function readQuestionPages(blob: Blob, range: string, signal: AbortSignal,
  report: (page: number, total: number) => void) {
  if (!range.trim()) throw new Error('请填写题目所在页码，如 8-9。');
  const pdf = await openPdf(blob);
  try {
    const pages = selectPages(range, pdf.numPages);
    if (pages.length > 20) throw new Error('一次最多读取 20 页，请选择题目所在的页面。');
    const texts: string[] = [], emptyPages: number[] = [];
    for (const [index, number] of pages.entries()) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = questionPageText(content.items.flatMap(item => 'str' in item ? [{
          str: item.str, x: item.transform[4], y: item.transform[5],
          size: Math.hypot(item.transform[2], item.transform[3]) || item.height || 12, width: item.width,
        }] : []));
        if (text) texts.push(text); else emptyPages.push(number);
      } finally { page.cleanup(); }
      report(index + 1, pages.length);
      await pause();
    }
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    return { text: texts.join('\n\n'), emptyPages };
  } finally { await pdf.destroy(); }
}
function canvasBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('页面图像生成失败')), type, .92));
}
export async function renderPage(pdf: PDFDocumentProxy, number: number, width = 1200, masks: FooterLine[] = [], omitted = new Set<number>()): Promise<Blob> {
  const page = await pdf.getPage(number);
  const viewport = page.getViewport({ scale: Math.min(2, width / page.getViewport({ scale: 1 }).width) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, operationsFilter: i => !omitted.has(i) }).promise;
  const ctx = canvas.getContext('2d')!;
  const scale = viewport.width / page.getViewport({ scale: 1 }).width;
  for (const mask of masks) {
    const x = Math.max(0, Math.floor((mask.x - 1.5) * scale)), y = Math.max(0, Math.floor((mask.top - 1.5) * scale));
    const right = Math.min(canvas.width, Math.ceil((mask.right + 1.5) * scale));
    const bottom = Math.min(canvas.height, Math.ceil((mask.bottom + 1.5) * scale));
    if (right <= x || bottom <= y) continue;
    const samples: number[][] = [];
    for (const px of [x - 2, right + 1]) for (const py of [y - 2, bottom + 1]) {
      const pixel = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, px)), Math.max(0, Math.min(canvas.height - 1, py)), 1, 1).data;
      samples.push([...pixel]);
    }
    const background = [0, 1, 2].map(channel => samples.map(pixel => pixel[channel]).sort((a, b) => a - b)[2]);
    ctx.fillStyle = `rgb(${background.join(',')})`; ctx.fillRect(x, y, right - x, bottom - y);
  }
  const blob = await canvasBlob(canvas);
  canvas.width = canvas.height = 0;
  return blob;
}
let fontPromise: Promise<ArrayBuffer> | undefined;
async function fontBytes() {
  fontPromise ||= fetch(asset('fonts/NotoSansSC-Regular.ttf')).then(r => { if (!r.ok) throw new Error('字体加载失败，请检查网络后重试。'); return r.arrayBuffer(); }).catch(e => { fontPromise = undefined; throw e; });
  return fontPromise;
}
type Row = { text: string; runs: Run[]; x: number; right: number; top: number; bottom: number; size: number; split: boolean };
type Extracted = { number: number; width: number; height: number; rows: Row[]; images: ImageRegion[]; complex: boolean; accent?: number[] };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const redColor = (c: number[]) => c[0] > .35 && c[0] > c[1] * 1.5 && c[0] > c[2] * 1.3;
const normPaint = (s: string) => clean(s).replace(/\s/g, '');
const point = (p: number[], m: number[]) => [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
async function extract(page: PDFPageProxy, number: number): Promise<Extracted> {
  const viewport = page.getViewport({ scale: 1 });
  const text = await page.getTextContent();
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  let color = [0, 0, 0], matrix = [1, 0, 0, 1, 0, 0];
  const saved: { color: number[]; matrix: number[] }[] = [];
  let paint = ''; const colors: boolean[] = [];
  let unknownImages = false, paths = 0;
  const images: ImageRegion[] = [];
  const imageBounds = (m: number[], operation: number, mask = false) => {
    const vm = pdfjs.Util.transform(viewport.transform, m);
    const corners = [[0, 0], [0, 1], [1, 0], [1, 1]].map(p => point(p, vm));
    const x = Math.max(0, Math.min(...corners.map(p => p[0]))), right = Math.min(viewport.width, Math.max(...corners.map(p => p[0])));
    const top = Math.max(0, Math.min(...corners.map(p => p[1]))), bottom = Math.min(viewport.height, Math.max(...corners.map(p => p[1])));
    if (right > x && bottom > top) images.push({ operation, x, right, top, bottom, mask });
  };
  const accentColors: number[][] = [];
  const lines: { x0: number; x1: number; y: number }[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === O.save || fn === O.paintFormXObjectBegin || fn === O.beginGroup) {
      saved.push({ color: [...color], matrix: [...matrix] });
      const transform = fn === O.paintFormXObjectBegin ? args[0] : fn === O.beginGroup ? args[0]?.matrix : undefined;
      if (transform) matrix = pdfjs.Util.transform(matrix, transform);
    }
    else if (fn === O.restore || fn === O.paintFormXObjectEnd || fn === O.endGroup) { const state = saved.pop(); if (state) { color = state.color; matrix = state.matrix; } }
    else if (fn === O.transform) matrix = pdfjs.Util.transform(matrix, args);
    else if (fn === O.setFillRGBColor) {
      if (typeof args[0] === 'string') { const hex = args[0].replace('#', ''); color = [0, 2, 4].map(n => parseInt(hex.slice(n, n + 2), 16) / 255); }
      else { color = [...args].slice(0, 3); if (Math.max(...color) > 1) color = color.map(n => n / 255); }
      if (Math.max(...color) - Math.min(...color) > .2 && Math.max(...color) > .3) accentColors.push([...color]);
    } else if (fn === O.showText || fn === O.showSpacedText || fn === O.nextLineShowText) {
      const glyphs = args[0];
      if (Array.isArray(glyphs)) for (const glyph of glyphs) if (glyph && typeof glyph === 'object' && glyph.unicode) {
        const chars = normPaint(glyph.unicode); paint += chars; for (let j = 0; j < chars.length; j++) colors.push(redColor(color));
      }
    } else if ([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject].includes(fn)) {
      imageBounds(matrix, i, fn === O.paintImageMaskXObject);
    } else if (fn === O.paintImageXObjectRepeat) {
      for (let j = 0; j < args[3].length; j += 2) imageBounds(pdfjs.Util.transform(matrix, [args[1], 0, 0, args[2], args[3][j], args[3][j + 1]]), i);
    } else if (fn === O.paintInlineImageXObjectGroup && Array.isArray(args[1])) {
      for (const entry of args[1]) imageBounds(pdfjs.Util.transform(matrix, entry.transform), i);
    } else if ([O.paintImageMaskXObjectGroup, O.paintImageMaskXObjectRepeat, O.paintInlineImageXObjectGroup, O.paintSolidColorImageMask].includes(fn)) {
      unknownImages = true;
    } else if (fn === O.constructPath) {
      paths++;
      // PDF.js path bounds contain underline positions, also for transformed source pages.
      const bounds = args[2];
      if (Array.isArray(bounds) || bounds instanceof Float32Array) {
        const vm = pdfjs.Util.transform(viewport.transform, matrix);
        const a = point([bounds[0], bounds[1]], vm), b = point([bounds[2], bounds[3]], vm);
        if (Math.abs(a[1] - b[1]) < 2 && Math.abs(a[0] - b[0]) > 10) lines.push({ x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y: (a[1] + b[1]) / 2 });
      }
    }
  }
  const parts: (Row & { baseline: number })[] = [];
  let paintCursor = 0;
  for (const item of text.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const t = pdfjs.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(t[2], t[3]);
    const font = text.styles[item.fontName];
    const baseline = t[5], top = baseline - size * (font?.ascent || .85);
    const str = clean(item.str), needle = normPaint(str);
    let offset = paint.indexOf(needle, paintCursor);
    if (offset < 0) offset = paint.indexOf(needle);
    const runs: Run[] = [];
    let k = 0;
    for (const ch of str) {
      const red = offset >= 0 && !!colors[offset + k];
      if (!/\s/.test(ch)) k += ch.length;
      const underline = lines.some(l => Math.abs(l.y - baseline) < size * .25 && l.x0 < t[4] + item.width && l.x1 > t[4]);
      const prior = runs.at(-1);
      if (prior && prior.red === red && prior.underline === underline) prior.text += ch;
      else runs.push({ text: ch, red, underline });
    }
    if (offset >= 0) paintCursor = offset + needle.length;
    parts.push({ text: str, runs, x: t[4], right: t[4] + item.width, top, bottom: top + size, size, baseline, split: false });
  }
  parts.sort((a, b) => Math.abs(a.baseline - b.baseline) < Math.min(a.size, b.size) * .28 ? a.x - b.x : a.baseline - b.baseline);
  const rows: Row[] = [];
  for (const part of parts) {
    const last = rows.at(-1);
    if (last && part.x >= last.x && part.x - last.right < part.size * 4 && Math.abs(last.bottom - part.bottom) < Math.min(last.size, part.size) * .3) {
      const gap = part.x - last.right;
      if (gap > part.size * 4) last.split = true;
      if (gap > part.size * .15 && /[a-zA-Z0-9]$/.test(last.text) && /^[a-zA-Z0-9]/.test(part.text)) { last.runs.push({ text: ' ' }); last.text += ' '; }
      last.text += part.text; last.runs.push(...part.runs); last.right = Math.max(last.right, part.right); last.bottom = Math.max(last.bottom, part.bottom);
    } else rows.push({ ...part });
  }
  // Compare tiny visual samples across pages, rather than PDF object IDs (which vary between pages).
  if (images.some(image => !image.mask)) {
    const preview = page.getViewport({ scale: Math.min(1, 960 / viewport.width) });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(preview.width); canvas.height = Math.ceil(preview.height);
    const tile = document.createElement('canvas'); tile.width = tile.height = 12;
    try {
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: preview }).promise;
      const ctx = tile.getContext('2d', { willReadFrequently: true })!, scale = preview.width / viewport.width;
      for (const image of images) if (!image.mask) {
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 12, 12);
        ctx.drawImage(canvas, image.x * scale, image.top * scale, (image.right - image.x) * scale, (image.bottom - image.top) * scale, 0, 0, 12, 12);
        const pixels = ctx.getImageData(0, 0, 12, 12).data;
        image.sample = Uint8Array.from(pixels.filter((_, index) => index % 4 !== 3));
      }
    } finally { canvas.width = canvas.height = tile.width = tile.height = 0; }
  }
  return { number, width: viewport.width, height: viewport.height, rows, images,
    complex: unknownImages || images.some(image => image.mask) || paths > 35 || rows.filter(r => r.split && r.top > viewport.height * .2).length > 2 || rows.length === 0,
    accent: accentColors[0] };
}

export async function simplify(blob: Blob, title: string, options: Options, signal: AbortSignal,
  report: (progress: number, stage: string, message: string) => void): Promise<{ blob: Blob; images: SavedImageReview[]; stats: NonNullable<Job['stats']> }> {
  const check = () => { if (signal.aborted) throw new DOMException('已取消', 'AbortError'); };
  const pdf = await openPdf(blob);
  try {
    const selected = selectPages(options.pages, pdf.numPages), extracted: Extracted[] = [];
    for (const [i, n] of selected.entries()) {
      check(); report(Math.round(3 + 25 * i / selected.length), 'reading', `正在读取第 ${i + 1} / ${selected.length} 页`);
      const sourcePage = await pdf.getPage(n);
      extracted.push(await extract(sourcePage, n)); sourcePage.cleanup(); await pause();
    }
    const footerMasks = repeatedFooterSignatures(extracted);
    let removedSignatures = 0;
    for (const p of extracted) {
      const masks = new Set(footerMasks.get(p.number) || []);
      removedSignatures += masks.size;
      p.rows = p.rows.filter(row => !masks.has(row));
    }
    const basic = classifyImages(extracted);
    const visualCache = new Map<string, NonNullable<ImageRegion['visual']>>();
    let visualImages = 0;
    const images: SavedImageReview[] = [];
    for (const [index, p] of extracted.entries()) {
      check();
      if (!p.images.length) continue;
      report(Math.round(29 + 17 * index / extracted.length), 'images', `正在检查第 ${p.number} 页图片`);
      const bitmap = await createImageBitmap(await renderPage(pdf, p.number, 1400));
      try {
        const scale = bitmap.width / p.width;
        const groups = new Map<number, ImageRegion[]>();
        for (const image of p.images) { const group = groups.get(image.operation) || []; group.push(image); groups.set(image.operation, group); }
        for (const [operation, group] of groups) {
          check();
          const bounds = { x: Math.min(...group.map(g => g.x)), right: Math.max(...group.map(g => g.right)), top: Math.min(...group.map(g => g.top)), bottom: Math.max(...group.map(g => g.bottom)) };
          const crop = document.createElement('canvas');
          const ratio = Math.min(1, 480 / Math.max((bounds.right - bounds.x) * scale, (bounds.bottom - bounds.top) * scale));
          crop.width = Math.max(1, Math.round((bounds.right - bounds.x) * scale * ratio));
          crop.height = Math.max(1, Math.round((bounds.bottom - bounds.top) * scale * ratio));
          try {
            crop.getContext('2d')!.drawImage(bitmap, bounds.x * scale, bounds.top * scale, (bounds.right - bounds.x) * scale, (bounds.bottom - bounds.top) * scale, 0, 0, crop.width, crop.height);
            const decisions = (basic.get(p.number) || []).filter(d => d.image.operation === operation);
            const id = imageKey(p.number, operation);
            const locked = group.some(g => g.mask) || (bounds.right - bounds.x) * (bounds.bottom - bounds.top) / (p.width * p.height) > .85;
            // Do not infer on protected diagrams, formula masks or entire scanned slides.
            if ((options.imageMode ?? 'smart') === 'smart' && !locked && group.length === 1 && decisions.every(d => !d.remove && d.reason !== 'content') && options.imageOverrides?.[id] === undefined) {
              const input = document.createElement('canvas'); input.width = input.height = 224;
              try {
                const ctx = input.getContext('2d', { willReadFrequently: true })!;
                ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 224, 224);
                const fit = Math.min(224 / crop.width, 224 / crop.height), w = crop.width * fit, h = crop.height * fit;
                ctx.drawImage(crop, (224 - w) / 2, (224 - h) / 2, w, h);
                const pixels = ctx.getImageData(0, 0, 224, 224).data;
                report(Math.round(29 + 17 * index / extracted.length), 'images', `正在本地识别第 ${p.number} 页配图`);
                const cacheKey = `${crop.width}:${crop.height}:${group[0].sample?.join(',')}`;
                group[0].visual = visualCache.get(cacheKey) || await inspectVisual(Uint8Array.from(pixels.filter((_, k) => k % 4 !== 3)), 224, 224,
                  options.modelHost === 'official' ? 'https://huggingface.co/' : 'https://hf-mirror.com/', signal, message => report(Math.round(29 + 17 * index / extracted.length), 'images', message));
                if (group[0].sample) visualCache.set(cacheKey, group[0].visual);
                visualImages++;
              } finally { input.width = input.height = 0; }
            }
            images.push({ id, page: p.number, thumbnail: await canvasBlob(crop, 'image/jpeg'), removed: false, reason: '', locked });
          } finally { crop.width = crop.height = 0; }
        }
      } finally { bitmap.close(); (await pdf.getPage(p.number)).cleanup(); }
      await pause();
    }
    report(47, 'organizing', '正在应用图片筛选结果');
    const imageDecisions = classifyImages(extracted);
    const reasonNames = { content: '图注、图文叠加或整页内容，保留', template: '重复装饰', promotion: '推广配图', visual: '视觉模型判定为普通配图，建议核对', uncertain: '用途不确定，保留', manual: '按你的选择处理' };
    for (const p of extracted) for (const d of imageDecisions.get(p.number) || []) {
      const id = imageKey(p.number, d.image.operation), review = images.find(image => image.id === id)!;
      if (options.imageOverrides?.[id] !== undefined && !review.locked) { d.remove = options.imageOverrides[id]; d.reason = 'manual'; }
      review.removed = d.remove;
      review.reason = review.locked ? '整页截图或公式遮罩，保留；无法单独删除内部配图' : reasonNames[d.reason];
      if (d.image.visual) review.reason += ` · ${visualVerdict(d.image.visual).label}`;
    }
    const omittedFor = (number: number) => new Set((imageDecisions.get(number) || []).filter(d => d.remove).map(d => d.image.operation));
    const removedImages = [...imageDecisions.values()].flat().filter(d => d.remove).length;
    const bytes = await fontBytes(); check();
    const out = await PDFDocument.create(); out.registerFontkit(fontkit);
    const font = await out.embedFont(bytes, { subset: false });
    const supported = new Set(font.getCharacterSet());
    const frequency = new Map<string, number>();
    for (const p of extracted) for (const r of p.rows) frequency.set(fingerprint(r.text), (frequency.get(fingerprint(r.text)) || 0) + 1);
    const tree = new Structure(); let imagePages = 0, preservedImages = 0;
    let accent = extracted.find(p => p.accent)?.accent || [.65, .23, .2];
    if (options.background === 'text-only') accent = [.27, .27, .27];
    let banner: Uint8Array | undefined;
    if (options.background === 'source-full') {
      const p = extracted.find(p => p.rows.some(r => r.top < p.height * .14)) || extracted[0];
      const img = await createImageBitmap(await renderPage(pdf, p.number, 1400, footerMasks.get(p.number), omittedFor(p.number)));
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = Math.round(img.height * .155);
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const scale = img.width / p.width;
      const bandX = Math.round(img.width * .26), bandW = Math.round(img.width * .43);
      const pixels = ctx.getImageData(bandX, 0, bandW, canvas.height).data;
      let ruleTop = canvas.height - 2;
      for (let y = Math.round(img.height * .08); y < canvas.height; y++) {
        let colored = 0;
        for (let x = 0; x < bandW; x++) {
          const k = (y * bandW + x) * 4;
          if (pixels[k] > 75 && pixels[k] > pixels[k + 1] * 1.6 && pixels[k] > pixels[k + 2] * 1.4) colored++;
        }
        if (colored > bandW * .7) { ruleTop = y; break; }
      }
      for (const r of p.rows) if (r.bottom < p.height * .14 && r.x > p.width * .2 && r.right < p.width * .77) {
        const pixel = ctx.getImageData(Math.max(0, Math.round(r.x * scale)), 2, 1, 1).data;
        ctx.fillStyle = `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`;
        ctx.fillRect(r.x * scale - 2, 0, (r.right - r.x) * scale + 4, Math.max(0, ruleTop - 2));
      }
      banner = new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer()); img.close(); canvas.width = canvas.height = 0;
    }
    for (const [i, p] of extracted.entries()) {
      check(); report(Math.round(48 + 31 * i / extracted.length), 'organizing', `正在衔接第 ${i + 1} / ${selected.length} 页正文`);
      const keptImages = (imageDecisions.get(p.number) || []).filter(d => !d.remove).map(d => d.image);
      // Independent images are cropped and inserted among searchable text. Keep connected/overlaid diagrams intact.
      const raster = p.complex || keptImages.some(image => p.rows.some(row => intersects(image, row)))
        || keptImages.some((image, index) => keptImages.slice(index + 1).some(other => intersects(image, other)))
        || p.rows.some(r => [...r.text].some(c => !supported.has(c.codePointAt(0)!) && !/\s/.test(c)));
      if (raster) {
        const section = p.rows.find(r => r.bottom < p.height * .18 && headingRank(r.text) === 3);
        if (section) tree.heading(section.text, 3, p.number);
        const image = new Uint8Array(await (await renderPage(pdf, p.number, 1800, footerMasks.get(p.number), omittedFor(p.number))).arrayBuffer());
        tree.block({ kind: 'image', runs: [], pages: [p.number], image, width: p.width, height: p.height }); imagePages++;
        preservedImages += Math.max(1, keptImages.length);
        (await pdf.getPage(p.number)).cleanup(); await pause(); continue;
      }
      let pending: { runs: Run[]; bottom: number; size: number } | undefined;
      const flush = () => { if (pending) tree.block({ kind: 'paragraph', runs: pending.runs, pages: [p.number] }); pending = undefined; };
      const orderedRows = [...p.rows].sort((a, b) => {
        if (a.bottom < p.height * .155 && b.bottom < p.height * .155) {
          const ac = a.right < p.width * .22, bc = b.right < p.width * .22;
          if (ac !== bc) return ac ? -1 : 1;
        }
        return a.top - b.top;
      });
      let pageBitmap: ImageBitmap | undefined;
      const remaining = [...keptImages].sort((a, b) => a.top - b.top);
      const insertImages = async (before: number) => {
        while (remaining.length && remaining[0].top < before) {
          const region = remaining.shift()!; flush();
          pageBitmap ||= await createImageBitmap(await renderPage(pdf, p.number, 1800, footerMasks.get(p.number), omittedFor(p.number)));
          const scale = pageBitmap.width / p.width, crop = document.createElement('canvas');
          crop.width = Math.max(1, Math.ceil((region.right - region.x) * scale)); crop.height = Math.max(1, Math.ceil((region.bottom - region.top) * scale));
          try {
            crop.getContext('2d')!.drawImage(pageBitmap, region.x * scale, region.top * scale, (region.right - region.x) * scale, (region.bottom - region.top) * scale, 0, 0, crop.width, crop.height);
            tree.block({ kind: 'image', runs: [], pages: [p.number], image: new Uint8Array(await (await canvasBlob(crop)).arrayBuffer()), width: region.right - region.x, height: region.bottom - region.top });
            preservedImages++;
          } finally { crop.width = crop.height = 0; }
        }
      };
      try {
      for (const row of orderedRows) {
        await insertImages(row.top);
        const corner = row.bottom < p.height * .18 && (row.right < p.width * .22 || row.x > p.width * .78);
        // Repeated template text is retained once as a heading; arbitrary recurring footnotes are retained as body.
        if (/^\d+$/.test(row.text) && row.top > p.height * .94) continue;
        let rank = headingRank(row.text);
        if (!rank && row.bottom < p.height * .15 && (frequency.get(fingerprint(row.text)) || 0) > 1 && row.text.length < 60) rank = corner ? 2 : 3;
        if (rank) { flush(); tree.heading(row.text, rank, p.number); continue; }
        const starts = /^[•●▪]|^[（(]\d+[）)]|^[A-D][.．、]|^[【《]|^\d+[.．、]/.test(row.text);
        if (pending && !starts && row.top - pending.bottom < row.size * 1.1 && Math.abs(row.size - pending.size) < 2) {
          if (/[a-zA-Z0-9]$/.test(pending.runs.at(-1)!.text) && /^[a-zA-Z0-9]/.test(row.text)) pending.runs.push({ text: ' ' });
          pending.runs.push(...row.runs); pending.bottom = row.bottom;
        } else { flush(); pending = { runs: [...row.runs], bottom: row.bottom, size: row.size }; }
      }
      flush(); await insertImages(Infinity);
      } finally { pageBitmap?.close(); }
      (await pdf.getPage(p.number)).cleanup(); await pause();
    }
    report(81, 'exporting', '正在排版可搜索、可批注的讲义');
    await layoutPdf(out, font, tree.root, title, options, accent, banner, check, report);
    check(); report(96, 'exporting', '正在封装 PDF 与章节书签'); await pause();
    const output = await out.save(); check();
    return { blob: new Blob([output as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), images, stats: { source_pages: selected.length, result_pages: out.getPageCount(),
      removed_headings: tree.removedHeadings, removed_paragraphs: tree.removedParagraphs, image_pages: imagePages, preserved_images: preservedImages, removed_images: removedImages, visual_images: visualImages, removed_signatures: removedSignatures } };
  } finally { closeVision(); await pdf.destroy(); }
}

async function layoutPdf(out: PDFDocument, font: PDFFont, root: Topic, title: string, options: Options, accent: number[], bannerBytes: Uint8Array | undefined,
  check: () => void, report: (p: number, s: string, m: string) => void) {
  const W = 595.28, H = 841.89, left = 48, right = options.layout === 'notes' ? 150 : 48;
  const bodySize = options.layout === 'compact' ? 10.5 : 11.5, leading = bodySize * 1.7, lineWidth = W - left - right;
  const ink = rgb(.18, .18, .17), muted = rgb(.54, .53, .5), color = rgb(accent[0], accent[1], accent[2]);
  const banner = bannerBytes ? await out.embedPng(bannerBytes) : undefined;
  let page!: PDFPage, y = 0, chapter = title;
  const charset = new Set(font.getCharacterSet());
  const safe = (s: string) => [...s].filter(c => charset.has(c.codePointAt(0)!)).join('');
  function trim(s: string, max: number, size: number) { let value = safe(s); while (value && font.widthOfTextAtSize(value, size) > max) value = value.slice(0, -1); return value; }
  function newPage() {
    page = out.addPage([W, H]); y = H - (banner ? 83 : 66);
    if (banner) page.drawImage(banner, { x: 0, y: H - 48, width: W, height: 48 });
    else if (options.background !== 'text-only') page.drawLine({ start: { x: left, y: H - 34 }, end: { x: W - 48, y: H - 34 }, color, thickness: .8 });
    page.drawText(trim(chapter, W - 100, 8), { x: left, y: H - (banner ? 65 : 49), size: 8, font, color: muted });
    page.drawText(String(out.getPageCount()), { x: W - 55, y: 27, size: 8, font, color: muted });
    if (options.layout === 'notes') page.drawLine({ start: { x: W - right + 25, y: 50 }, end: { x: W - right + 25, y: H - 90 }, color: rgb(.9, .89, .87), thickness: .4 });
  }
  const need = (height: number) => { if (!page || y - height < 49) newPage(); };
  function wrap(runs: Run[], size: number): Run[][] {
    const result: Run[][] = []; let line: Run[] = [], width = 0;
    const push = () => { if (line.length) result.push(line); line = []; width = 0; };
    for (const run of runs) {
      // Keep Latin words together where possible, while allowing character wrapping for long URLs.
      for (const token of run.text.match(/[a-zA-Z0-9]+(?:[’'_-][a-zA-Z0-9]+)*|[^a-zA-Z0-9]/gu) || []) {
        if (token === '\n') { push(); continue; }
        const tw = font.widthOfTextAtSize(token, size);
        if (width + tw > lineWidth && width > 0 && tw <= lineWidth) push();
        for (const ch of token) {
          const cw = font.widthOfTextAtSize(ch, size);
          if (width + cw > lineWidth && width > 0) push();
          if (!line.length && ch === ' ') continue;
          const prior = line.at(-1);
          if (prior && prior.red === run.red && prior.underline === run.underline) prior.text += ch;
          else line.push({ ...run, text: ch });
          width += cw;
        }
      }
    }
    push(); return result;
  }
  function paragraph(runs: Run[], size = bodySize, tint = ink) {
    for (const line of wrap(runs, size)) {
      need(size * 1.7); let x = left;
      for (const run of line) {
        const c = run.red ? rgb(.75, 0, 0) : tint;
        page.drawText(run.text, { x, y: y - size, size, font, color: c });
        const width = font.widthOfTextAtSize(run.text, size);
        if (run.underline) page.drawLine({ start: { x, y: y - size - 2 }, end: { x: x + width, y: y - size - 2 }, color: c, thickness: .5 });
        x += width;
      }
      y -= size === bodySize ? leading : size * 1.7;
    }
    y -= size * .45;
  }
  const bookmarks: { text: string; page: PDFPage; y: number; depth: number; pages: number[] }[] = [];
  const toc: { text: string; target?: { page: PDFPage; y: number }; page: PDFPage; y: number }[] = [];
  const headings: { node: Topic; depth: number }[] = [];
  const collect = (n: Topic, depth: number) => { if (n.text) headings.push({ node: n, depth }); n.children.forEach(c => collect(c, depth + 1)); };
  collect(root, 0);
  newPage(); paragraph([{ text: safe(title) }], 17, color); y -= 7;
  if (headings.length > 3) {
    const top = headings.filter(h => h.node.rank <= 3).slice(0, 18);
    if (top.length) {
      paragraph([{ text: '阅读导航' }], 9, muted);
      for (const h of top) {
        need(16); const yy = y;
        page.drawText(trim(h.node.text, lineWidth - 10, 9), { x: left, y: y - 9, size: 9, font, color: muted });
        toc.push({ text: h.node.text, page, y: yy }); y -= 16;
      }
      y -= 15;
    }
  }
  let visited = 0;
  async function visit(n: Topic, depth: number) {
    check();
    if (n.text) {
      if (n.rank <= 3) chapter = n.text;
      const first = n.body[0];
      const imageSpace = first?.kind === 'image' ? Math.min(H - 190, lineWidth * (first.height || 1) / (first.width || 1)) + leading * 3 : 0;
      need(Math.max(leading * 3, imageSpace)); if (y < H - 90) y -= depth > 2 ? 5 : 10;
      const mark = { text: n.text, page, y, depth, pages: [...n.pages].sort((a, b) => a - b) };
      bookmarks.push(mark); const entry = toc.find(t => t.text === n.text && !t.target); if (entry) entry.target = mark;
      paragraph([{ text: n.text }], depth <= 2 ? 12 : bodySize, depth <= 2 ? color : ink);
    }
    for (const b of n.body) {
      check();
      if (b.kind === 'image' && b.image) {
        const image = await out.embedPng(b.image);
        let w = lineWidth, h = w * image.height / image.width;
        const max = H - 190; if (h > max) { w *= max / h; h = max; }
        need(h + 15); page.drawImage(image, { x: left, y: y - h, width: w, height: h }); y -= h + 12;
      } else paragraph(b.runs);
      if (options.sourceMode === 'inline') paragraph([{ text: `原 PDF 第 ${b.pages.join('、')} 页` }], 7.5, muted);
      if (++visited % 8 === 0) { report(86, 'exporting', `正在排版讲义第 ${out.getPageCount()} 页`); await pause(); }
    }
    for (const child of n.children) await visit(child, depth + 1);
  }
  await visit(root, 0);
  if (options.sourceMode === 'appendix') {
    need(60); y -= 18; paragraph([{ text: '原课件页码对照' }], 12, color);
    for (const b of bookmarks) paragraph([{ text: `${b.text}  ·  第 ${b.pages.join('、')} 页` }], 9, muted);
    if (root.body.length) paragraph([{ text: `未分节内容  ·  第 ${[...root.pages].join('、')} 页` }], 9, muted);
  }
  // Internal navigation and outlines use real PDF destinations, independent of source labels.
  const dest = (b: { page: PDFPage; y: number }) => out.context.obj([b.page.ref, 'XYZ', null, b.y, null]);
  for (const t of toc) if (t.target) {
    const annotation = out.context.register(out.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [left, t.y - 13, W - right, t.y + 2], Border: [0, 0, 0], Dest: dest(t.target) }));
    t.page.node.addAnnot(annotation);
  }
  if (bookmarks.length) {
    const outline = out.context.obj({ Type: 'Outlines' }); const outlineRef = out.context.register(outline);
    const entries = bookmarks.map(b => out.context.obj({ Title: PDFHexString.fromText(b.text + (options.sourceMode === 'bookmarks' ? `（原第 ${b.pages.join('、')} 页）` : '')), Parent: outlineRef, Dest: dest(b) }));
    const refs = entries.map(e => out.context.register(e));
    entries.forEach((e, i) => { if (i > 0) e.set(PDFName.of('Prev'), refs[i - 1]); if (i < refs.length - 1) e.set(PDFName.of('Next'), refs[i + 1]); });
    outline.set(PDFName.of('First'), refs[0]); outline.set(PDFName.of('Last'), refs.at(-1)!); outline.set(PDFName.of('Count'), out.context.obj(refs.length));
    out.catalog.set(PDFName.of('Outlines'), outlineRef);
  }
  out.setTitle(safe(title) + ' · 复习讲义'); out.setCreator('simple ppt · 浏览器本地整理'); out.setProducer('simpleppt / pdf-lib'); out.catalog.set(PDFName.of('Lang'), PDFString.of('zh-CN'));
}

export async function examplePdf(): Promise<File> {
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await fontBytes(), { subset: false });
  const content = [
    ['（一）连贯阅读', '• 连续阅读让注意力停留在知识本身。', '• 反复出现的标题，可以只保留一次。'],
    ['（一）连贯阅读', '• 连续阅读让注意力停留在知识本身。', '• 解释紧跟对应知识点，读起来更自然。'],
    ['（二）保留原文', '• 只合并完全重复的内容，不把讲义变成摘要。', '• 金额、日期、否定词和例外条件都应保留。'],
  ];
  content.forEach((lines, index) => {
    const page = pdf.addPage([960, 540]);
    page.drawLine({ start: { x: 48, y: 470 }, end: { x: 912, y: 470 }, thickness: 2, color: rgb(.7, .12, .12) });
    ['第一节 把知识连起来', '一、复习的方法', ...lines].forEach((str, i) => page.drawText(str, { x: i === 0 ? 290 : 65, y: i === 0 ? 495 : 425 - (i - 1) * 62, size: i < 3 ? 25 : 22, font, color: i === 0 ? rgb(.7, .12, .12) : rgb(.15, .15, .15) }));
    page.drawText(String(index + 1), { x: 900, y: 15, size: 12, font });
  });
  return new File([await pdf.save() as Uint8Array<ArrayBuffer>], '连贯阅读·示例课件.pdf', { type: 'application/pdf' });
}
