// 样式仅作用于插件自己的元素；使用宿主的颜色与字号，跟随亮暗主题。
export const interactionStyles = `
.acn-trigger,.acn-item,.acn-tab,.acn-dismiss{color:inherit;background:transparent;border:0;font:inherit;cursor:pointer}
.acn-trigger{height:28px;display:inline-flex;flex:none;align-items:center;gap:5px;padding:0 7px;border-radius:7px;white-space:nowrap;color:var(--dsw-alias-label-secondary,GrayText);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1;font-weight:500}
.acn-short-label{max-width:145px;overflow:hidden;text-overflow:ellipsis}
.acn-trigger:hover,.acn-trigger[aria-expanded=true],.acn-item:not(:disabled):not([aria-disabled=true]):hover,.acn-dismiss:hover,.acn-tab:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#8882))}
.acn-trigger:focus-visible,.acn-item:focus-visible,.acn-tab:focus-visible,.acn-dismiss:focus-visible,.acn-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:1px}
.acn-mark{position:relative;display:inline-flex}
.acn-mark[data-state]::after{content:"";position:absolute;right:-2px;top:-2px;width:6px;height:6px;border:1px solid var(--dsw-alias-bg-base,Canvas);border-radius:50%;background:var(--dsw-alias-state-business-primary,#4268bd)}
.acn-mark[data-state=warning]::after{background:var(--dsw-alias-state-warning-primary,#b76b09)}
.acn-mark[data-state=team]::after{background:var(--dsw-alias-state-success-primary,#268353)}
@container (max-width:420px){.acn-trigger .acn-short-label,.acn-trigger .acn-chevron{display:none}}
.acn-surface{box-sizing:border-box;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:12px;box-shadow:0 6px 24px #0002}
.acn-menu{position:fixed;z-index:10001;width:min(276px,calc(100vw - 16px));padding:6px;overflow:auto;overscroll-behavior:contain;font-size:13px}
.acn-menu p{margin:5px 7px;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.acn-separator{border:0;border-top:1px solid var(--dsw-alias-border-l1,#8883);margin:5px 2px}
.acn-item{display:flex;align-items:center;gap:9px;width:100%;text-align:start;border-radius:6px;padding:6px 8px;min-height:32px;line-height:1.4;overflow-wrap:anywhere}
.acn-item svg,.acn-trigger svg{flex:none}.acn-item:disabled,.acn-item[aria-disabled=true],.acn-btn:disabled{opacity:.5;cursor:default}
.acn-item small{margin-inline-start:auto;color:var(--dsw-alias-label-secondary,GrayText);font-size:11px;white-space:nowrap}
.acn-notice{position:fixed;z-index:10000;inset-block-start:16px;inset-inline-end:16px;width:max-content;max-width:min(360px,calc(100vw - 32px));padding:10px 12px;display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.acn-notice p{margin:3px 0}.acn-dismiss{display:inline-grid;place-items:center;flex:none;width:26px;height:26px;border-radius:6px;color:var(--dsw-alias-label-secondary,GrayText)}
.acn-page{box-sizing:border-box;width:100%;min-width:0;max-width:800px;padding:3px 1px 16px;line-height:1.5;font-size:14px;color:var(--dsw-alias-label-primary,CanvasText)}
.acn-tabs{display:flex;gap:16px;align-items:stretch;border-bottom:1px solid var(--dsw-alias-border-l2,#8884);margin:0 0 18px}
.acn-tab{padding:7px 2px 9px;color:var(--dsw-alias-label-secondary,GrayText);font-size:14px;border-bottom:2px solid transparent}
.acn-tab[aria-selected=true]{border-bottom-color:currentColor;color:var(--dsw-alias-label-primary,CanvasText);font-weight:600}
.acn-page h3{font-size:14px;font-weight:600;margin:18px 0 4px}.acn-page .acn-field{display:grid;gap:5px;font-size:13px;font-weight:550;margin:14px 0}
.acn-connection-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:10px 14px;margin:14px 0 6px}.acn-connection-fields .acn-field{margin:0}.acn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px}
.acn-row{display:flex;align-items:center;justify-content:space-between;gap:10px 20px;flex-wrap:wrap;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#8883)}
.acn-row>div:first-child{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}.acn-row>div:last-child{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;max-width:100%}
.acn-btn:not(:disabled):hover{filter:brightness(.95)}
.acn-switch{appearance:none;width:32px;height:19px;box-sizing:border-box;flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#8885);border-radius:20px;background:var(--dsw-alias-bg-layer-2,#8884);display:inline-grid;align-items:center;padding:2px}
.acn-switch::after{content:"";width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-secondary,GrayText)}
.acn-switch:checked{background:var(--dsw-alias-label-primary,CanvasText)}.acn-switch:checked::after{transform:translateX(13px);background:var(--dsw-alias-bg-base,Canvas)}
.acn-modal-backdrop{position:fixed;inset:0;z-index:10002;background:#0005;display:grid;place-items:center;padding:clamp(8px,2vw,20px);box-sizing:border-box}
.acn-modal{width:min(720px,100%);max-height:min(84dvh,800px);display:flex;flex-direction:column;overflow:hidden}.acn-modal-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px;gap:12px}.acn-modal-header h2{font-size:16px;font-weight:600;line-height:1.5;margin:0}
.acn-modal-body{overflow:auto;overscroll-behavior:contain;min-width:0;padding:0 20px 18px}
@media (max-width:440px){.acn-tabs{gap:10px}.acn-modal-body{padding-inline:12px}.acn-notice{inset-inline-end:8px}}
`;
