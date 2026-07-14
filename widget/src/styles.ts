/**
 * Widget styles, injected into the shadow root so host-page CSS can never
 * leak in or out. Colors come from CSS custom properties set at mount time
 * from the business's branding.
 */
export const WIDGET_CSS = `
:host {
  all: initial;
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.root {
  position: fixed;
  bottom: 20px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}
.root.pos-right { right: 20px; }
.root.pos-left { left: 20px; align-items: flex-start; }

.launcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  border-radius: 9999px;
  background: var(--ar-primary);
  color: #fff;
  padding: 12px 18px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  transition: transform 0.15s ease;
}
.launcher:hover { transform: scale(1.04); }
.launcher svg { width: 18px; height: 18px; flex-shrink: 0; }

.panel {
  display: none;
  flex-direction: column;
  width: 360px;
  max-width: calc(100vw - 40px);
  height: 540px;
  max-height: calc(100vh - 110px);
  border-radius: 16px;
  overflow: hidden;
  background: var(--ar-bg);
  color: var(--ar-text);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.24);
}
.panel.open { display: flex; }

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  background: var(--ar-primary);
  color: #fff;
}
.header .title { font-size: 15px; font-weight: 700; }
.header .subtitle { font-size: 12px; opacity: 0.85; margin-top: 1px; }
.header button {
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border-radius: 8px;
  width: 28px;
  height: 28px;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--ar-bg);
}
.msg {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.msg.user {
  align-self: flex-end;
  background: var(--ar-primary);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.msg.bot {
  align-self: flex-start;
  background: var(--ar-bubble);
  color: var(--ar-text);
  border-bottom-left-radius: 4px;
}
.msg.typing { color: var(--ar-muted); font-style: italic; }
.msg.error { background: #fee2e2; color: #b91c1c; }

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--ar-border);
  background: var(--ar-bg);
}
.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--ar-border);
  border-radius: 12px;
  background: var(--ar-input-bg);
  color: var(--ar-text);
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.4;
  max-height: 96px;
  outline: none;
}
.composer textarea:focus { border-color: var(--ar-primary); }
.iconbtn {
  border: none;
  border-radius: 12px;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: var(--ar-primary);
  color: #fff;
}
.iconbtn:disabled { opacity: 0.5; cursor: default; }
.iconbtn.mic { background: var(--ar-bubble); color: var(--ar-text); }
.iconbtn.mic.listening {
  background: #dc2626;
  color: #fff;
  animation: ar-pulse 1.2s ease-in-out infinite;
}
.iconbtn.mic.speaking {
  background: var(--ar-primary);
  color: #fff;
  animation: ar-pulse-soft 1.6s ease-in-out infinite;
}
.iconbtn svg { width: 18px; height: 18px; }
.voicestatus {
  display: none;
  padding: 6px 16px 0;
  font-size: 12px;
  color: var(--ar-muted);
  text-align: center;
  background: var(--ar-bg);
}
.voicestatus.visible { display: block; }
@keyframes ar-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5); }
  50% { box-shadow: 0 0 0 8px rgba(220, 38, 38, 0); }
}
@keyframes ar-pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
}
.hint {
  padding: 0 16px 10px;
  font-size: 11px;
  color: var(--ar-muted);
  text-align: center;
  background: var(--ar-bg);
}

.theme-light {
  --ar-bg: #ffffff;
  --ar-text: #0f172a;
  --ar-muted: #94a3b8;
  --ar-bubble: #f1f5f9;
  --ar-border: #e2e8f0;
  --ar-input-bg: #ffffff;
}
.theme-dark {
  --ar-bg: #0f172a;
  --ar-text: #f1f5f9;
  --ar-muted: #64748b;
  --ar-bubble: #1e293b;
  --ar-border: #334155;
  --ar-input-bg: #1e293b;
}
@media (max-width: 480px) {
  .panel { width: calc(100vw - 40px); height: 70vh; }
}
`;
