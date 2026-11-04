// 普通设置反馈浮在窗口顶部，停留后淡出，不占用表单布局。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
export function SettingsToast({ text }: { text: string }) {
  const [leaving, setLeaving] = useState(false); const [visible, setVisible] = useState(true);
  useEffect(() => {
    const fade = setTimeout(() => { setLeaving(true); }, 3200);
    const end = setTimeout(() => { setVisible(false); }, 3420);
    return () => { clearTimeout(fade); clearTimeout(end); };
  }, []);
  return visible ? createPortal(<div role="status" className={`acn-settings-toast${leaving ? ' is-leaving' : ''}`}><span className="acn-toast-dot" aria-hidden="true" /><span>{text}</span></div>, document.body) : null;
}
