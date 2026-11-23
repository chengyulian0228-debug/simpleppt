import { useEffect, useRef, useState } from 'react';
import { Check, Image as ImageIcon, RotateCcw, Trash2, X } from 'lucide-react';
import type { Job } from './types';

export default function ImageReview({ job, onClose, onApply }: { job: Job; onClose: () => void; onApply: (overrides: Record<string, boolean>) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>(() => Object.fromEntries((job.images || []).map(image => [image.id, image.removed])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const images = job.images || [];
  const changed = images.some(image => choices[image.id] !== image.removed);
  const count = images.filter(image => choices[image.id]).length;
  const apply = async () => {
    setSaving(true); setError('');
    try { await onApply(choices); }
    catch (e) { setError(e instanceof Error ? e.message : '重新生成失败'); setSaving(false); }
  };
  return <dialog ref={dialog} className="modal image-review-modal" onCancel={e => { if (saving) e.preventDefault(); else onClose(); }} onClick={e => { if (!saving && e.target === e.currentTarget) onClose(); }}>
    <header className="modal-header"><div><span className="eyebrow">每一张图片，都能核对</span><h2>检查图片</h2><p>{job.documentName}</p></div><button className="icon-button" aria-label="关闭图片检查" onClick={onClose} disabled={saving}><X size={20} /></button></header>
    <div className="image-review-body"><p className="image-review-intro">已标记删除 {count} 组图片。点击卡片可补删无关配图，也可恢复需要的图片；修改后重新生成讲义才会生效。模型无法准确判断所有课程的知识关联。</p>
      {images.length ? <div className="image-review-grid">{images.map(image => <button key={image.id} disabled={saving || image.locked} className={`image-review-card ${choices[image.id] ? 'will-remove' : ''}`} aria-pressed={choices[image.id]} aria-label={`原第 ${image.page} 页，${choices[image.id] ? '将删除，点击恢复' : image.locked ? '保留整页或公式' : '将保留，点击删除'}`} onClick={() => setChoices(old => ({ ...old, [image.id]: !old[image.id] }))}>
        <div className="image-review-picture"><img src={image.previewUrl} alt={`原第 ${image.page} 页图片`} loading="lazy" /></div>
        <div className="image-review-caption"><span>原第 {image.page} 页</span><strong>{choices[image.id] ? <><Trash2 size={13} />将删除</> : <><Check size={13} />保留</>}</strong></div>
        <small>{image.reason}</small>
      </button>)}</div> : <p className="image-review-empty"><ImageIcon size={26} />{job.images ? '没有提取到独立位图。矢量画或嵌在整页截图内的配图，目前无法单独识别删除。' : '这份讲义由旧版生成，请重新整理后检查图片。'}</p>}
      {error && <p className="question-error" role="alert">{error}</p>}
    </div><footer className="modal-footer image-review-footer"><button className="text-button" disabled={saving || !changed} onClick={() => setChoices(Object.fromEntries(images.map(image => [image.id, image.removed])))}><RotateCcw size={14} />撤销本次调整</button><button className="button primary small" disabled={saving || !changed} onClick={() => void apply()}>{saving ? '正在准备…' : '按选择重新生成'}</button></footer>
  </dialog>;
}
