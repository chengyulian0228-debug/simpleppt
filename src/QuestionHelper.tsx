import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ClipboardCopy, FileText, LoaderCircle, X } from 'lucide-react';
import type { DocumentInfo } from './types';
import { readDocumentQuestions } from './local-store';
import { buildQuestionPrompt, type QuestionMode } from './question-tools';

export default function QuestionHelper({ source, initialPage = '1', onClose }: {
  source: DocumentInfo | null; initialPage?: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const [range, setRange] = useState(initialPage);
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState('');
  const [mode, setMode] = useState<QuestionMode>('explain');
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const prompt = question.trim() ? buildQuestionPrompt(question, context, mode) : '';

  useEffect(() => {
    dialog.current?.showModal();
    return () => { controller.current?.abort(); };
  }, []);
  useEffect(() => { setCopied(false); setManualCopy(false); }, [question, context, mode]);
  useEffect(() => { if (manualCopy) { fallback.current?.focus(); fallback.current?.select(); } }, [manualCopy]);

  const read = async () => {
    if (!source || reading) return;
    const operation = new AbortController(); controller.current = operation;
    setReading(true); setError(''); setNotice(''); setProgress('正在读取');
    try {
      const result = await readDocumentQuestions(source.id, range, operation.signal,
        (page, total) => setProgress(`正在读取 ${page} / ${total} 页`));
      if (operation.signal.aborted) return;
      if (!result.text.trim()) {
        setNotice('这些页面没有可读取的文字，可能是扫描件。请手动输入题目；图片题可在 AI 工具中另附原页截图。');
        return;
      }
      setQuestion(previous => previous.trim() ? `${previous}\n\n${result.text}` : result.text);
      setNotice(result.emptyPages.length
        ? `已读取文字。第 ${result.emptyPages.join('、')} 页未读出文字，请对照原课件补充图片或题干。`
        : '已读取整页文字。请保留要问的题目，核对选项、数字与公式；图片内容需另行补充。');
    } catch (e) {
      if (!operation.signal.aborted) setError(e instanceof Error ? e.message : '读取失败，请直接粘贴题目。');
    } finally { if (!operation.signal.aborted) setReading(false); }
  };

  const copy = async () => {
    if (!prompt) return;
    setError('');
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setManualCopy(false); }
    catch { setManualCopy(true); }
  };

  return <dialog ref={dialog} className="modal question-modal" aria-labelledby="question-helper-title" onCancel={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <header className="modal-header"><div><span className="eyebrow">把问题带走，把思路打开</span><h2 id="question-helper-title">题目助手</h2><p>确认题目，复制提示词，到你常用的 AI 中继续。</p></div><button className="icon-button" aria-label="关闭题目助手" onClick={onClose}><X size={20} /></button></header>
    <div className="question-body">
      {source ? <section className="question-source" aria-label="从课件读题"><div className="question-source-name"><FileText size={16} /><span>{source.name}</span><small>{source.pageCount} 页</small></div><label htmlFor="question-pages">题目所在的原 PDF 页码</label><div className="question-read-row"><input id="question-pages" value={range} onChange={e => setRange(e.target.value)} placeholder="例如：8-9, 12" disabled={reading} /><button className="button secondary small" onClick={() => void read()} disabled={reading || !range.trim()}>{reading ? <LoaderCircle size={15} className="spin" /> : <FileText size={15} />}{reading ? progress : question.trim() ? '读取并追加' : '读取页面文字'}</button></div><small>按文件第一页起计数，一次最多 20 页；也可以直接在下方粘贴题目。</small></section>
        : <p className="question-intro">直接粘贴题目即可使用。先在工作台选择 PDF，还可以按页读取原题。</p>}
      {notice && <p className="question-notice" role="status">{notice}</p>}
      {error && <p className="question-error" role="alert">{error}</p>}
      <label className="question-label" htmlFor="question-text">要解析的题目<span>请保留完整题干、选项和限制条件</span></label>
      <textarea id="question-text" className="question-text" value={question} onChange={e => setQuestion(e.target.value)} placeholder="在这里粘贴或编辑题目。可以一次放入多道题，也可以先删去读入的无关正文。" disabled={reading} />
      <details className="question-context"><summary>补充课件中的相关知识（可选）<ChevronDown size={14} /></summary><label htmlFor="question-context">相关定义、法条或老师的解释</label><textarea id="question-context" value={context} onChange={e => setContext(e.target.value)} placeholder="只放与这道题有关的材料，帮助 AI 按老师的思路分析。" /></details>
      <fieldset className="question-modes"><legend>你希望怎样学习？</legend>{[
        { id: 'explain', title: '完整解析', detail: '思路、步骤、答案与易错点' },
        { id: 'hint', title: '先给提示', detail: '一步步追问，先自己思考' },
      ].map(item => <label key={item.id} className={mode === item.id ? 'selected' : ''}><input type="radio" name="question-mode" value={item.id} checked={mode === item.id} onChange={() => setMode(item.id as QuestionMode)} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></label>)}</fieldset>
      {prompt && <details className="question-prompt"><summary>预览将复制的提示词<ChevronDown size={14} /></summary><pre>{prompt}</pre></details>}
      {copied && <div className="question-success" role="status"><Check size={18} /><div><strong>已复制题目和提示词</strong><p>打开 ChatGPT、豆包、DeepSeek 等你常用的 AI，粘贴后发送即可。图片题请另附截图。</p></div></div>}
      {manualCopy && <div className="question-fallback" role="status"><label htmlFor="question-copy-fallback">浏览器暂不允许自动复制。请长按或按 Ctrl / ⌘ + C 复制已选中的内容。</label><textarea ref={fallback} id="question-copy-fallback" readOnly value={prompt} /></div>}
    </div>
    <footer className="modal-footer question-footer"><span>网站不调用 AI。只复制上方内容，由你选择粘贴到哪里。</span><button className="button primary" disabled={!prompt || reading} onClick={() => void copy()}>{copied ? <Check size={16} /> : <ClipboardCopy size={16} />}{copied ? '再次复制' : '复制题目＋提示词'}</button></footer>
  </dialog>;
}
