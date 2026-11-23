import { examplePdf, openPdf, renderPage, simplify, readQuestionPages } from './pdf-engine';
import { selectPages } from './structure';
import type { DocumentInfo, Job, Options, SavedImageReview } from './types';

type SavedDocument = Omit<DocumentInfo, 'previewUrl'> & { blob: Blob; thumbnail: Blob };
type SavedJob = Omit<Job, 'downloadUrl' | 'images'> & { blob?: Blob; images?: SavedImageReview[] };
let database: Promise<IDBDatabase> | undefined;
const jobs = new Map<string, SavedJob>(), controllers = new Map<string, AbortController>();
const urls = new Map<string, string>();
function db() {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('yejian-browser-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('documents', { keyPath: 'id' }); request.result.createObjectStore('jobs', { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error('浏览器本地存储不可用，请退出隐私模式后重试。')); };
  });
  return database;
}
async function read<T>(store: string, id?: string): Promise<T> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = id ? connection.transaction(store).objectStore(store).get(id) : connection.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function save(store: string, value: SavedDocument | SavedJob) {
  const connection = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = connection.transaction(store, 'readwrite'); tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('浏览器存储空间不足，请下载已有讲义并清空本机记录后重试。'));
  });
}
function url(key: string, blob: Blob) {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key)!;
}
function presentJob(j: SavedJob): Job {
  const { blob, images, ...info } = j;
  return { ...info, images: images?.map(({ thumbnail, ...image }) => ({ ...image, previewUrl: url(`image-${j.id}-${image.id}`, thumbnail) })), downloadUrl: blob ? url(`job-${j.id}`, blob) : undefined };
}
export async function importDocument(file: File, progress: (value: number) => void): Promise<DocumentInfo> {
  progress(10); const pdf = await openPdf(file);
  try {
    progress(60); const thumbnail = await renderPage(pdf, 1, 400);
    const doc: SavedDocument = { id: crypto.randomUUID(), name: file.name, size: file.size, pageCount: pdf.numPages, blob: file, thumbnail };
    await save('documents', doc); progress(100);
    const { blob: _blob, thumbnail: _thumbnail, ...info } = doc;
    return { ...info, previewUrl: url(`doc-${doc.id}`, thumbnail) };
  } finally { await pdf.destroy(); }
}
async function getJob(id: string) {
  let j = jobs.get(id);
  if (!j) {
    j = await read<SavedJob>('jobs', id);
    if (!j) throw new Error('这份整理记录已从当前浏览器移除。');
    if (['queued', 'processing'].includes(j.status)) { j.status = 'error'; j.error = '上次整理因页面关闭而中断，请重新放入文件开始。'; j.message = j.error; await save('jobs', j); }
    jobs.set(id, j);
  }
  return j;
}
async function run(j: SavedJob, input: Blob, controller: AbortController) {
  try {
    j.status = 'processing';
    const result = await simplify(input, j.documentName.replace(/\.pdf$/i, ''), j.options, controller.signal, (progress, stage, message) => Object.assign(j, { progress, stage, message }));
    Object.assign(j, { status: 'complete', progress: 100, stage: 'complete', message: '整理完成', blob: result.blob, stats: result.stats, images: result.images });
  } catch (e) {
    j.status = controller.signal.aborted ? 'cancelled' : 'error';
    j.error = j.status === 'error' ? (e instanceof Error ? e.message : '整理未完成，请尝试较小页码范围。') : undefined;
    j.message = j.error || '已取消';
  } finally {
    controllers.delete(j.id);
    try { await save('jobs', j); }
    catch { j.message = '已完成，但空间不足无法保存历史，请立即下载。'; }
  }
}
// This is an in-process service. It never sends the file or job data over HTTP.
export async function localApi<T>(path: string, init?: RequestInit): Promise<T> {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'example') return await importDocument(await examplePdf(), () => {}) as T;
  if (parts[0] === 'documents') {
    const doc = await read<SavedDocument>('documents', parts[1]);
    if (!doc) throw new Error('当前浏览器中找不到原文件，请重新选择。');
    const { blob: _blob, thumbnail, ...info } = doc;
    return { ...info, previewUrl: url(`doc-${doc.id}`, thumbnail) } as T;
  }
  if (parts[0] === 'jobs' && parts[1]) {
    const j = await getJob(parts[1]);
    if (parts[2] === 'cancel') { controllers.get(j.id)?.abort(); j.status = 'cancelled'; j.message = '已取消'; }
    return presentJob(j) as T;
  }
  if (parts[0] === 'jobs' && init?.method === 'POST') {
    if (controllers.size) throw new Error('请先等待当前整理完成，或取消后重试。');
    const body = JSON.parse(init.body as string) as { documentId: string; options: Options };
    const doc = await read<SavedDocument>('documents', body.documentId);
    if (!doc) throw new Error('原课件已清除，请重新选择。');
    selectPages(body.options.pages, doc.pageCount);
    const j: SavedJob = { id: crypto.randomUUID(), documentId: doc.id, documentName: doc.name, options: body.options,
      status: 'queued', progress: 0, stage: 'reading', message: '正在准备读取课件', createdAt: Date.now() / 1000 };
    jobs.set(j.id, j); await save('jobs', j);
    const controller = new AbortController(); controllers.set(j.id, controller);
    setTimeout(() => { void run(j, doc.blob, controller); }, 50);
    return presentJob(j) as T;
  }
  const saved = await read<SavedJob[]>('jobs');
  const all = await Promise.all(saved.map(j => getJob(j.id)));
  return all.sort((a, b) => b.createdAt - a.createdAt).map(presentJob) as T;
}
export async function previewPage(kind: 'documents' | 'jobs', id: string, number: number): Promise<Blob> {
  const saved = kind === 'documents' ? await read<SavedDocument>('documents', id) : await getJob(id);
  if (!saved?.blob) throw new Error('原文件或讲义已移除。');
  const pdf = await openPdf(saved.blob);
  try { return await renderPage(pdf, number); } finally { await pdf.destroy(); }
}
export async function readDocumentQuestions(id: string, range: string, signal: AbortSignal,
  report: (page: number, total: number) => void) {
  const doc = await read<SavedDocument>('documents', id);
  if (!doc) throw new Error('当前浏览器中找不到原课件，请重新选择文件，或直接粘贴题目。');
  return readQuestionPages(doc.blob, range, signal, report);
}
export async function clearHistory() {
  if (controllers.size) throw new Error('请先等待整理完成或取消当前整理。');
  const connection = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = connection.transaction(['documents', 'jobs'], 'readwrite');
    tx.objectStore('documents').clear(); tx.objectStore('jobs').clear();
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); jobs.clear();
}
