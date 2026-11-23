import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardCopy, Clock3, FileText, FileUp, FolderOpen, LayoutTemplate, LoaderCircle, LockKeyhole, PanelLeft, Plus, ScanLine, SlidersHorizontal, Sparkles, Upload, X } from 'lucide-react';
import type { DocumentInfo, Options, Job } from './types';
import { localApi as api, importDocument, previewPage, clearHistory } from './local-store';
import { mergePdfFiles, sortFilesByName } from './pdf-engine';
import QuestionHelper from './QuestionHelper';
import ImageReview from './ImageReview';
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const defaults: Options = { layout: 'balanced', background: 'source-frame', sourceMode: 'none', pages: '', imageMode: 'basic', modelHost: 'mirror' };
const layouts = [{ id: 'balanced', name: '均衡阅读', detail: '舒适字号，适度留白' }, { id: 'compact', name: '紧凑复习', detail: '内容更集中，少翻几页' }, { id: 'notes', name: '留白批注', detail: '右侧留出手写空间' }];
const backgrounds = [{ id: 'source-frame', name: '保留主风格', detail: '沿用主色，精简装饰' }, { id: 'text-only', name: '纯净正文', detail: '专注文字，去掉装饰' }];
const sourceNames: Record<string, string> = { none: '不显示来源', bookmarks: '仅在书签中显示', appendix: '放在文末对照表', inline: '在正文旁显示' };
const sizeLabel = (n: number) => n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const downloadName = (job: Job) => job.documentName.replace(/\.pdf$/i, '') + '_复习讲义.pdf';

function PreviewImage({ kind, id, page }: { kind: 'documents' | 'jobs'; id: string; page: number }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false, objectUrl = '';
    setSrc(''); setError('');
    previewPage(kind, id, page).then(blob => { if (!stopped) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } }).catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [kind, id, page]);
  return error ? <p role="alert">{error}</p> : src ? <img src={src} alt={`${kind === 'documents' ? '原课件' : '讲义'}第${page}页`} /> : <span role="status"><LoaderCircle size={24} className="spin" /> 正在渲染页面</span>;
}

function PaperMark({ variant = 'source-frame' }: { variant?: string }) {
  return <div className={`paper-mark ${variant}`} aria-hidden="true"><div className="mini-heading"><i /><i /></div><div className="mini-rule" /><div className="mini-lines"><i /><i /><i /><i /></div></div>;
}

function Modal({ children, onClose, className = '' }: { children: React.ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>{children}</dialog>;
}

function Preview({ job, onClose, onQuestions, onImages }: { job: Job; onClose: () => void; onImages: () => void; onQuestions: (page: string) => void }) {
  const initialPage = Number(job.options.pages.match(/\d+/)?.[0] || 1);
  const [sourcePage, setSourcePage] = useState(initialPage);
  const [resultPage, setResultPage] = useState(1);
  const [sourceCount, setSourceCount] = useState(initialPage);
  useEffect(() => { api<DocumentInfo>(`/documents/${job.documentId}`).then(d => setSourceCount(d.pageCount)).catch(() => {}); }, [job.documentId]);
  const pane = (original: boolean) => {
    const page = original ? sourcePage : resultPage;
    const count = original ? sourceCount : job.stats!.result_pages;
    const change = original ? setSourcePage : setResultPage;
    return <section className="preview-pane">
      <div className="preview-pane-head"><span>{original ? '原始课件' : '整理后的讲义'}</span><div className="page-controls"><button aria-label={original ? '原课件上一页' : '讲义上一页'} disabled={page <= 1} onClick={() => change(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {count}</span><button aria-label={original ? '原课件下一页' : '讲义下一页'} disabled={page >= count} onClick={() => change(page + 1)}><ChevronRight size={16} /></button></div></div>
      <div className="preview-sheet"><PreviewImage kind={original ? 'documents' : 'jobs'} id={original ? job.documentId : job.id} page={page} /></div>
    </section>;
  };
  return <Modal onClose={onClose} className="preview-modal"><header className="modal-header"><div><span className="eyebrow">把变化看清楚</span><h2>对比预览</h2><p>{job.documentName}</p></div><button className="icon-button" aria-label="关闭预览" onClick={onClose}><X size={20} /></button></header><div className="preview-grid">{pane(true)}{pane(false)}</div><footer className="modal-footer preview-footer"><span>请对照确认知识内容是否完整。</span><div><button className="button secondary small" onClick={onImages}>检查图片</button><button className="button secondary small" onClick={() => onQuestions(String(sourcePage))}><ClipboardCopy size={15} />读这一页的题目</button><a className="button primary small" href={job.downloadUrl} download={downloadName(job)}><ArrowDownToLine size={16} />下载讲义</a></div></footer></Modal>;
}

function App() {
  const [view, setView] = useState<'work' | 'history'>('work');
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [options, setOptions] = useState<Options>(defaults);
  const [partial, setPartial] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [recent, setRecent] = useState<Job[]>([]);
  const [preview, setPreview] = useState<Job | null>(null);
  const [guide, setGuide] = useState(false);
  const [imageReview, setImageReview] = useState<Job | null>(null);
  const [questionHelper, setQuestionHelper] = useState<{ source: DocumentInfo | null; initialPage: string } | null>(null);
  const [toast, setToast] = useState('');
  const [requesting, setRequesting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const active = !!job && ['queued', 'processing'].includes(job.status);
  const busy = uploading || requesting || active;
  const completed = job?.status === 'complete';
  const refreshHistory = () => api<Job[]>('/jobs').then(setRecent).catch(() => {});

  useEffect(() => { void refreshHistory(); }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (!job || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await api<Job>(`/jobs/${job.id}`);
        if (stopped) return;
        setJob(latest);
        if (['queued', 'processing'].includes(latest.status)) timer = setTimeout(poll, 800);
        else void refreshHistory();
      } catch { if (!stopped) timer = setTimeout(poll, 2000); }
    };
    timer = setTimeout(poll, 400);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, active]);

  const uploadFiles = async (incoming: FileList | File[], append = false) => {
    if (busy) return;
    const list = Array.from(incoming);
    if (!list.length) return;
    const invalid = list.find(f => !f.name.toLowerCase().endsWith('.pdf'));
    if (invalid) return setToast('目前支持 PDF，请先将课件导出为 PDF。');
    if (list.some(f => f.size === 0)) return setToast('不能选择内容为空的 PDF。');
    const nextQueue = append && queue.length ? [...queue, ...list] : sortFilesByName(list);
    const totalBytes = nextQueue.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) return setToast('单个或多个 PDF 总大小不能超过 300 MB。');
    setJob(null); setPartial(false); setOptions(o => ({ ...o, pages: '', imageOverrides: undefined }));
    if (nextQueue.length === 1) {
      setQueue(nextQueue);
      setUploading(true); setUploadProgress(0);
      try { setDocument(await importDocument(nextQueue[0], setUploadProgress)); }
      catch (error) { setQueue([]); setToast(error instanceof Error ? error.message : '文件读取失败，请重试。'); }
      finally { setUploading(false); }
    } else {
      setDocument(null);
      setQueue(nextQueue);
    }
  };

  const moveQueued = (index: number, delta: -1 | 1) => {
    if (busy) return;
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    const next = [...queue];
    [next[index], next[target]] = [next[target], next[index]];
    setQueue(next); setDocument(null); setJob(null);
  };

  const removeQueued = async (index: number) => {
    if (busy) return;
    const next = queue.filter((_, i) => i !== index);
    setJob(null);
    if (next.length === 0) { setQueue([]); setDocument(null); return; }
    if (next.length === 1) {
      setQueue(next); setUploading(true); setUploadProgress(0);
      try { setDocument(await importDocument(next[0], setUploadProgress)); }
      catch (error) { setQueue([]); setToast(error instanceof Error ? error.message : '文件读取失败，请重试。'); }
      finally { setUploading(false); }
    } else { setQueue(next); setDocument(null); }
  };

  const example = async () => {
    if (busy) return;
    setUploading(true); setJob(null); setUploadProgress(0); setView('work'); setQueue([]);
    try { setDocument(await api<DocumentInfo>('/example', { method: 'POST' })); setPartial(false); setOptions(o => ({ ...o, pages: '', imageOverrides: undefined })); }
    catch (error) { setToast(error instanceof Error ? error.message : '示例暂时无法打开'); }
    finally { setUploading(false); }
  };

  const start = async () => {
    if ((!document && queue.length === 0) || busy) return;
    if (partial && !options.pages.trim()) return setToast('请填写想整理的页码，如 5-10, 18。');
    setRequesting(true);
    try {
      let target = document;
      if (!target && queue.length > 0) {
        setUploading(true); setUploadProgress(0);
        try {
          const combined = queue.length > 1 ? await mergePdfFiles(queue, p => setUploadProgress(Math.round(p * .6))) : queue[0];
          target = await importDocument(combined, p => setUploadProgress(60 + Math.round(p * .4)));
          setDocument(target);
        } finally { setUploading(false); }
      }
      if (!target) return;
      const result = await api<Job>('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: target.id, options: { ...options, pages: partial ? options.pages : '' } }) });
      setJob(result);
    } catch (error) { setToast(error instanceof Error ? error.message : '暂时无法开始整理'); }
    finally { setRequesting(false); }
  };

  const regenerateImages = async (overrides: Record<string, boolean>) => {
    if (!imageReview || busy) return;
    const source = await api<DocumentInfo>('/documents/' + imageReview.documentId);
    const nextOptions = { ...imageReview.options, imageOverrides: overrides };
    const next = await api<Job>('/jobs', { method: 'POST', body: JSON.stringify({ documentId: source.id, options: nextOptions }) });
    setDocument(source); setOptions(nextOptions); setPartial(!!nextOptions.pages); setJob(next); setView('work'); setImageReview(null);
  };

  const cancel = async () => {
    if (!job) return;
    try { setJob(await api<Job>(`/jobs/${job.id}/cancel`, { method: 'POST' })); void refreshHistory(); }
    catch { setToast('取消未完成，请重试。'); }
  };

  const clear = async () => {
    try { await clearHistory(); setRecent([]); setDocument(null); setJob(null); setToast('已清空当前浏览器的课件与讲义记录。'); }
    catch (e) { setToast(e instanceof Error ? e.message : '清空未完成'); }
  };

  const openQuestions = async (sourceJob?: Job, page = '1') => {
    try {
      const source = sourceJob ? await api<DocumentInfo>(`/documents/${sourceJob.documentId}`) : document;
      setQuestionHelper({ source, initialPage: page });
    } catch { setToast('原课件已从浏览器移除，请重新选择文件后读题。'); }
  };

  const historyList = () => recent.length ? <div className="history-list">{recent.map(item => <button className="history-row" key={item.id} onClick={() => { if (item.status === 'complete') setPreview(item); else { setJob(item); setView('work'); api<DocumentInfo>(`/documents/${item.documentId}`).then(setDocument).catch(() => {}); } }}><span className="history-file"><FileText size={20} /></span><span className="history-text"><strong>{item.documentName}</strong><small>{new Date(item.createdAt * 1000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} · {item.stats ? `${item.stats.source_pages} 页 → ${item.stats.result_pages} 页` : item.message}</small></span><span className={`status-badge ${item.status}`}>{({ complete: '已整理', processing: '整理中', queued: '等待中', error: '未完成', cancelled: '已取消' } as Record<string, string>)[item.status]}</span><ArrowUpRight size={17} /></button>)}</div> : <div className="history-empty"><FolderOpen size={27} /><p>还没有整理记录</p><span>讲义仅保存在当前浏览器，清除网站数据后记录会消失。</span></div>;

  return <div className="app-shell">
    <aside className="sidebar"><a href="#" className="brand" onClick={e => { e.preventDefault(); setView('work'); }}><span className="brand-icon"><BookOpen size={25} strokeWidth={1.5} /></span><span>simple ppt</span></a><nav><button className={view === 'work' ? 'nav-item selected' : 'nav-item'} onClick={() => setView('work')}><PanelLeft size={18} /><span>整理课件</span>{view === 'work' && <i />}</button><button className={view === 'history' ? 'nav-item selected' : 'nav-item'} onClick={() => { setView('history'); void refreshHistory(); }}><Clock3 size={18} /><span>最近整理</span>{recent.length > 0 && <em>{recent.length}</em>}</button></nav><div className="sidebar-art" aria-hidden="true"><svg viewBox="0 0 184 320" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="92" cy="74" r="56" stroke="#e8dfd4" strokeWidth="1" strokeDasharray="3 4" /><circle cx="92" cy="242" r="54" stroke="#e8dfd4" strokeWidth="1" strokeDasharray="3 4" /><g transform="rotate(-8 66 56)"><rect x="26" y="24" width="76" height="50" rx="5" fill="#f7f2ea" stroke="#dfd4c6" strokeWidth="1.2" /><line x1="36" y1="36" x2="66" y2="36" stroke="#c9846f" strokeWidth="2.2" strokeLinecap="round" /><line x1="36" y1="47" x2="88" y2="47" stroke="#dfd5c8" strokeWidth="1.5" strokeLinecap="round" /><line x1="36" y1="56" x2="76" y2="56" stroke="#e6ddd2" strokeWidth="1.5" strokeLinecap="round" /></g><g transform="rotate(6 118 76)"><rect x="78" y="44" width="78" height="50" rx="5" fill="#fcfaf5" stroke="#dfd4c6" strokeWidth="1.2" /><line x1="88" y1="56" x2="120" y2="56" stroke="#c9846f" strokeWidth="2.2" strokeLinecap="round" /><line x1="88" y1="67" x2="142" y2="67" stroke="#dfd5c8" strokeWidth="1.5" strokeLinecap="round" /><line x1="88" y1="76" x2="132" y2="76" stroke="#e6ddd2" strokeWidth="1.5" strokeLinecap="round" /></g><g transform="rotate(-3 84 106)"><rect x="44" y="78" width="84" height="52" rx="5" fill="#fffdf9" stroke="#d8cbbd" strokeWidth="1.2" /><line x1="55" y1="90" x2="88" y2="90" stroke="#b86b56" strokeWidth="2.2" strokeLinecap="round" /><line x1="55" y1="101" x2="114" y2="101" stroke="#d8cec1" strokeWidth="1.6" strokeLinecap="round" /><line x1="55" y1="110" x2="106" y2="110" stroke="#e4dcd1" strokeWidth="1.6" strokeLinecap="round" /><line x1="55" y1="119" x2="90" y2="119" stroke="#e4dcd1" strokeWidth="1.6" strokeLinecap="round" /></g><path d="M56 132 C56 150 92 146 92 162" stroke="#d8c7b8" strokeWidth="1.2" strokeDasharray="3 3" /><path d="M128 100 C134 138 92 142 92 162" stroke="#d8c7b8" strokeWidth="1.2" strokeDasharray="3 3" /><line x1="92" y1="132" x2="92" y2="176" stroke="#c3846f" strokeWidth="1.4" strokeLinecap="round" /><path d="M87 171 L92 177 L97 171" stroke="#b86b56" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><circle cx="92" cy="156" r="3" fill="#b86b56" fillOpacity=".8" /><g transform="rotate(-4 86 244)"><rect x="44" y="190" width="82" height="106" rx="7" fill="#f7f2ea" stroke="#e2d7ca" strokeWidth="1.2" /></g><g transform="rotate(2 96 244)"><rect x="54" y="188" width="84" height="108" rx="7" fill="#fffdf9" stroke="#d8cbbd" strokeWidth="1.2" /><path d="M114 188h12v22l-6-4.5-6 4.5V188Z" fill="#b86b56" fillOpacity=".85" /><line x1="66" y1="208" x2="102" y2="208" stroke="#b86b56" strokeWidth="2.3" strokeLinecap="round" /><line x1="66" y1="222" x2="124" y2="222" stroke="#d6cbc0" strokeWidth="1.6" strokeLinecap="round" /><line x1="66" y1="231" x2="120" y2="231" stroke="#e2dad0" strokeWidth="1.6" strokeLinecap="round" /><line x1="66" y1="240" x2="110" y2="240" stroke="#e2dad0" strokeWidth="1.6" strokeLinecap="round" /><rect x="66" y="250" width="58" height="14" rx="3" fill="#f5ede3" /><line x1="66" y1="274" x2="122" y2="274" stroke="#e2dad0" strokeWidth="1.6" strokeLinecap="round" /><line x1="66" y1="283" x2="98" y2="283" stroke="#e2dad0" strokeWidth="1.6" strokeLinecap="round" /></g><circle cx="30" cy="148" r="2.2" fill="#c9937e" fillOpacity=".55" /><circle cx="152" cy="166" r="2.5" fill="#c9937e" fillOpacity=".5" /><circle cx="36" cy="272" r="2" fill="#c9937e" fillOpacity=".45" /></svg></div><div className="sidebar-bottom"><button className="guide-link" onClick={() => setGuide(true)}><CircleHelp size={17} />使用指南<ArrowUpRight size={15} /></button></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumb">工作台 <span>/</span> <strong>{view === 'work' ? '整理课件' : '最近整理'}</strong></div><div className="local-status"><i />浏览器处理<span>文件无需上传至云端</span></div></header>
      <div className="content">
      {view === 'work' ? <>
        <section className="hero"><div className="hero-copy"><div className="eyebrow"><span />给复习，做一次减法</div><h1>让课件安静下来，<br /><span>把注意力还给知识。</span></h1><p>合并重复标题，接续跨页正文。<br className="mobile-break" />把零散的课件，整理成连贯的复习讲义。</p><button className="text-button" onClick={example} disabled={busy}>先用一份示例试试看<ArrowUpRight size={15} /></button></div><div className="hero-illustration" aria-hidden="true"><div className="illustration-orbit" /><div className="sketch-paper back-paper"><span>原始课件</span><i className="sketch-red" /><i /><i /><i className="sketch-red" /><i /><i /><i className="sketch-red" /><i /></div><div className="sketch-paper front-paper"><div className="sketch-page-head"><BookOpen size={15} /><span>复习讲义</span><i /></div><h3>知识，本就连贯。</h3><i /><i /><i /><i className="half-line" /><div className="sketch-paragraph" /><i /><i /><i className="half-line" /></div><span className="illustration-caption"><CheckCheck size={15} />少一些重复，多一些连贯</span></div></section>

        <section className="workbench" aria-label="PDF 整理工作台">
          <div className="section-head"><span className="step">01</span><h2>放入你的课件</h2><span className="section-hint">从一份 PDF 开始</span></div>
          <input ref={input} type="file" multiple accept="application/pdf,.pdf" className="file-input" aria-label="选择 PDF 课件" onChange={e => { if (e.target.files?.length) void uploadFiles(e.target.files, queue.length > 0 && !completed); e.target.value = ''; }} />
          <div className={`dropzone ${dragging ? 'dragging' : ''} ${document || queue.length > 0 ? 'has-file' : ''}`} onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files, queue.length > 0 && !completed); }}>
            {uploading ? <div className="upload-state"><LoaderCircle className="spin" size={27} /><h3>{queue.length > 1 ? `正在合并 ${queue.length} 份课件` : uploadProgress ? '正在放入你的课件' : '正在读取课件'}</h3><p>{uploadProgress < 100 ? `${uploadProgress}%` : '正在检查文件，请稍等…'}</p><div className="upload-meter"><i style={{ width: `${uploadProgress}%` }} /></div></div> : queue.length > 1 ? <div className="merge-queue"><div className="merge-head"><div><span className="file-label"><FileText size={13} />合并 {queue.length} 份 PDF</span><small>总计 {sizeLabel(queue.reduce((s, f) => s + f.size, 0))} · 按顺序合并整理</small></div><div className="merge-head-actions"><button className="text-button" onClick={() => input.current?.click()} disabled={busy}><Plus size={14} />继续添加</button><button className="text-button" onClick={() => { setQueue([]); setDocument(null); setJob(null); }} disabled={busy}>清空</button></div></div><ul className="merge-list">{queue.map((f, idx) => <li key={`${f.name}-${f.size}-${idx}`}><span className="merge-index">{idx + 1}</span><span className="merge-name" title={f.name}>{f.name}</span><span className="merge-size">{sizeLabel(f.size)}</span><div className="merge-controls"><button className="icon-button" aria-label="上移" disabled={busy || idx === 0} onClick={() => moveQueued(idx, -1)}><ArrowUp size={14} /></button><button className="icon-button" aria-label="下移" disabled={busy || idx === queue.length - 1} onClick={() => moveQueued(idx, 1)}><ArrowDown size={14} /></button><button className="icon-button" aria-label="移除" disabled={busy} onClick={() => void removeQueued(idx)}><X size={14} /></button></div></li>)}</ul></div> : document ? <div className="selected-document"><div className="document-thumbnail"><img src={document.previewUrl} alt="原课件首页" /></div><div className="document-details"><span className="file-label"><FileText size={13} />PDF 课件</span><h3>{document.name}</h3><p>{document.pageCount} 页<span>·</span>{sizeLabel(document.size)}<span>·</span><em><Check size={13} />已就绪</em></p><div className="selected-actions"><button className="text-button replace-file" onClick={() => input.current?.click()} disabled={busy}><Plus size={13} />继续添加合并</button><button className="text-button replace-file" onClick={() => { setQueue([]); setDocument(null); setJob(null); setTimeout(() => input.current?.click(), 0); }} disabled={busy}>换一份课件</button></div></div><button className="icon-button remove-document" aria-label="移除当前课件" disabled={busy} onClick={() => { setQueue([]); setDocument(null); setJob(null); }}><X size={17} /></button></div> : <div className="upload-empty"><span className="upload-icon"><FileUp size={28} strokeWidth={1.4} /></span><h3>把 PDF 拖到这里</h3><p>支持一次选择或拖入多份 PDF 合并整理</p><button className="button upload-button" onClick={() => input.current?.click()}><Upload size={15} />选择 PDF 文件</button><small>支持多份 PDF 合并，总计最大 300 MB</small></div>}
          </div>
          <div className="file-assurance"><LockKeyhole size={13} /><span>文件留在你的浏览器中，不上传课件。</span><span className="assurance-right">原文件保持不变</span></div>
          <div className="section-divider" />
          <div className="section-head"><span className="step">02</span><h2>选择你的阅读方式</h2><span className="section-hint">每个人，都有自己的节奏</span></div>
          <fieldset disabled={busy} className="settings-fieldset"><legend className="sr-only">整理选项</legend>
            <div className="option-label">讲义版式<span>所有选项均保留正文信息</span></div>
            <div className="layout-options">{layouts.map((item, index) => <button key={item.id} className={`layout-option ${options.layout === item.id ? 'chosen' : ''}`} onClick={() => setOptions({ ...options, layout: item.id })} aria-pressed={options.layout === item.id}><span className={`layout-icon layout-${index}`} aria-hidden="true"><i /><i /><i /><i /></span><span><strong>{item.name}{index === 0 && <em>推荐</em>}</strong><small>{item.detail}</small></span><span className="choice-circle">{options.layout === item.id && <Check size={10} strokeWidth={3} />}</span></button>)}</div>
            <div className="option-label background-label">原课件风格<span>熟悉的风格，更清爽的呈现</span></div>
            <div className="background-options">{backgrounds.map(item => <button key={item.id} className={`background-option ${options.background === item.id ? 'chosen' : ''}`} onClick={() => setOptions({ ...options, background: item.id })} aria-pressed={options.background === item.id}><PaperMark variant={item.id} /><span><strong>{item.name}</strong><small>{item.detail}</small></span><span className="choice-circle">{options.background === item.id && <Check size={10} strokeWidth={3} />}</span></button>)}</div>
            <button className={`advanced-toggle ${advanced ? 'expanded' : ''}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={14} />更多设置<span>页码范围与来源显示</span><ChevronDown size={15} /></button>
            {advanced && <div className="advanced-panel"><div className="advanced-setting"><label htmlFor="source-mode">来源显示</label><select id="source-mode" value={options.sourceMode} onChange={e => setOptions({ ...options, sourceMode: e.target.value })}>{Object.entries(sourceNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>默认保持正文干净，不添加原页码提示。</small></div><div className="advanced-setting"><label className="checkbox-label"><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} />只整理部分页面</label><input className="range-input" disabled={!partial} placeholder={partial ? '例如：5-10, 18' : '默认整理全部页面'} value={partial ? options.pages : ''} aria-label="要整理的原 PDF 页码" onChange={e => setOptions({ ...options, pages: e.target.value })} /><small>按 PDF 文件从第一页开始计数。</small></div></div>}
            <div className="image-settings"><div className="option-label">图片清理<span>保留流程图、题图和文字截图</span></div><label className="checkbox-label"><input type="checkbox" checked={(options.imageMode ?? 'basic') === 'smart'} onChange={e => setOptions({ ...options, imageMode: e.target.checked ? 'smart' : 'basic', imageOverrides: undefined })} />本地视觉识别普通配图</label><p>可选。首次开启下载约 154 MB 模型，生成后可在“检查图片”中手动调整。</p>{(options.imageMode ?? 'basic') === 'smart' && <label className="model-source">模型下载源<select aria-label="模型下载源" value={options.modelHost || 'mirror'} onChange={e => setOptions({ ...options, modelHost: e.target.value as 'mirror' | 'official' })}><option value="mirror">国内镜像（HF Mirror）</option><option value="official">Hugging Face 官方</option></select></label>}</div>
          </fieldset>
          {active ? <div className="processing-panel" role="status" aria-live="polite"><div className="processing-title"><span className="processing-symbol"><Sparkles size={20} /></span><div><strong>正在把知识连起来</strong><p>{job.message}</p></div><span className="progress-number">{job.progress}%</span></div><div className="progress-track"><i style={{ width: `${job.progress}%` }} /></div><div className="processing-bottom"><span>{[{ id: 'reading', name: '读取课件' }, { id: 'images', name: '识别图片' }, { id: 'organizing', name: '合并重复' }, { id: 'exporting', name: '生成讲义' }].map((s, i) => <span className={job.stage === s.id ? 'current-stage' : ''} key={s.id}>{i > 0 && <ChevronRight size={11} />}{s.name}</span>)}</span><button onClick={cancel}>取消整理</button></div></div> : completed ? <div className="result-panel"><div className="result-title"><span className="result-check"><Check size={21} /></span><div><h3>讲义整理好了，继续专注吧。</h3><p>{job.stats!.source_pages} 页课件，整理为 <strong>{job.stats!.result_pages} 页</strong>连贯讲义</p></div><span className="result-seal">READY TO READ</span></div><div className="result-details"><span><Check size={13} />合并 {job.stats!.removed_headings} 处重复标题</span><span><Check size={13} />合并 {job.stats!.removed_paragraphs} 处重复正文</span>{!!job.stats!.removed_signatures && <span><Check size={13} />清理 {job.stats!.removed_signatures} 处重复页脚署名</span>}{job.stats!.removed_images !== undefined && <span><Check size={13} />移除 {job.stats!.removed_images} 处图片</span>}{job.stats!.visual_images !== undefined && <span><ScanLine size={13} />{Object.keys(job.options.imageOverrides || {}).length ? '已按核对选择处理图片' : '本地模型识别 ' + job.stats!.visual_images + ' 张配图'}</span>}{job.stats!.image_pages > 0 && <span><ScanLine size={13} />{job.stats!.image_pages} 页图片内容已保留原图</span>}</div><div className="result-actions"><button className="button secondary" onClick={() => setImageReview(job)}>检查图片</button><button className="button secondary" onClick={() => setPreview(job)}><LayoutTemplate size={16} />对比预览</button><a className="button primary" href={job.downloadUrl} download={downloadName(job)}><ArrowDownToLine size={16} />下载复习讲义</a><button className="text-button restart" onClick={() => setJob(null)}>调整后重新整理</button></div></div> : <><div className="action-row"><span><CheckCheck size={16} />轻标题 · 连续正文 · 保留原文</span><button className="button primary start-button" disabled={(!document && queue.length === 0) || busy} onClick={start}>{requesting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{queue.length > 1 ? `合并并整理（${queue.length} 份）` : '开始整理'}<ArrowRight size={16} /></button></div>{job?.status === 'error' && <p className="inline-error" role="alert">{job.error}</p>}{job?.status === 'cancelled' && <p className="cancel-note">已取消。文件和选项仍在，可以随时重新开始。</p>}</>}
        </section>
        <section className="question-card" aria-label="题目助手"><span className="question-card-icon"><ClipboardCopy size={22} /></span><div><h2>课件里的题目，继续弄明白。</h2><p>读取或粘贴原题，一键复制解析提示词，带到你常用的 AI 中。</p></div><button className="button secondary small" onClick={() => void openQuestions()} disabled={busy}>打开题目助手<ArrowUpRight size={15} /></button></section>
        <section className="recent-section"><div className="recent-heading"><h2><Clock3 size={16} />最近整理</h2>{recent.length > 3 && <button className="text-button" onClick={() => setView('history')}>查看全部<ArrowRight size={14} /></button>}</div>{recent.length ? <div className="history-list compact-history">{recent.slice(0, 3).map(item => <button className="history-row" key={item.id} onClick={() => { if (item.status === 'complete') setPreview(item); else setView('history'); }}><FileText size={18} /><span className="history-text"><strong>{item.documentName}</strong><small>{item.stats ? `${item.stats.source_pages} 页 → ${item.stats.result_pages} 页` : item.message}</small></span><span className="history-open">{item.status === 'complete' ? '打开讲义' : '查看记录'}<ArrowUpRight size={14} /></span></button>)}</div> : <div className="recent-empty"><span>还没有整理记录。下一份清爽的讲义，就从这里开始。</span><BookOpen size={20} /></div>}</section>
      </> : <section className="history-page"><div className="eyebrow">每一次整理，都为理解留一点空间</div><h1>你的复习书桌</h1><p className="history-intro">讲义仅保存在当前浏览器，换设备时请先下载。</p><div className="history-page-head"><h2>最近整理 <span>{recent.length}</span></h2><button className="text-button" onClick={clear} disabled={busy || !recent.length}>清空本机记录</button><button className="button primary small" onClick={() => setView('work')}><FileUp size={15} />整理新课件</button></div>{historyList()}</section>}
      <footer className="page-footer"><span><BookOpen size={13} />simple ppt</span><p>把时间留给理解，而不是寻找正文。</p></footer>
      </div>
    </main>
    {toast && <div className="toast" role="alert"><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
    {imageReview && <ImageReview job={imageReview} onClose={() => setImageReview(null)} onApply={regenerateImages} />}
    {preview && <Preview job={preview} onClose={() => setPreview(null)} onImages={() => { setImageReview(preview); setPreview(null); }} onQuestions={page => void openQuestions(preview, page)} />}
    {questionHelper && <QuestionHelper source={questionHelper.source} initialPage={questionHelper.initialPage} onClose={() => setQuestionHelper(null)} />}
    {guide && <Modal onClose={() => setGuide(false)} className="guide-modal"><header className="modal-header"><div><span className="eyebrow">一点简单的帮助</span><h2>让复习轻一点</h2></div><button className="icon-button" aria-label="关闭指南" onClick={() => setGuide(false)}><X size={20} /></button></header><div className="guide-body"><article><span>01</span><div><h3>放入一份 PDF 课件</h3><p>点击选择或拖入文件。你也可以先用示例体验整理流程。</p></div></article><article><span>02</span><div><h3>选一种适合自己的阅读方式</h3><p>均衡适合日常阅读；紧凑适合集中复习；留白为手写笔记预留空间。背景和来源显示都可以选择。</p></div></article><article><span>03</span><div><h3>对比一下，再带走讲义</h3><p>整理完成后，左右对比原课件与讲义，下载 PDF 后可继续高亮和批注。</p></div></article><div className="guide-note"><LockKeyhole size={17} /><p>文件在你的浏览器中处理，不上传服务器。仅按标题层级合并完全重复的内容，不改写正文，也不做 OCR。开启本地视觉识别后，首次从所选模型源下载约 154 MB 模型，在浏览器中检查普通配图；重复装饰和明确的推广图片仍按规则清理。流程图、题图、文字截图和不确定的图优先保留。图片分类不等于理解全部知识关联；生成后可在“检查图片”中补删或恢复并重新生成。整页截图内部的配图目前无法单独删除。历史仅保存在当前浏览器，清除网站数据后会消失。</p></div></div><footer className="modal-footer"><span>准备好给课件做减法了吗？</span><button className="button primary small" onClick={() => { setGuide(false); void example(); }}>试试示例<ArrowUpRight size={15} /></button></footer></Modal>}
  </div>;
}

export default App;
