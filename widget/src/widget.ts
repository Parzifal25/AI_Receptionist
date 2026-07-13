import type { SpeechProvider, SpeechRecognitionSession } from "@/core/ports/speech-provider";
import { BrowserSpeechProvider } from "@/providers/speech/browser-speech-provider";
import { WidgetApi, WidgetApiError, type WidgetConfig } from "./api";
import { WIDGET_CSS } from "./styles";

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
const SEND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const MIC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

/**
 * The embeddable receptionist widget. Renders inside a shadow root so it is
 * fully isolated from the host page. Holds no secrets — it only knows its
 * public widget key and a per-conversation visitor token.
 */
export class ReceptionistWidget {
  private readonly speech: SpeechProvider = new BrowserSpeechProvider();
  private shadow!: ShadowRoot;
  private panel!: HTMLDivElement;
  private launcher!: HTMLButtonElement;
  private messagesEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private micBtn: HTMLButtonElement | null = null;

  private visitorToken: string | null = null;
  private recognition: SpeechRecognitionSession | null = null;
  private voiceMode = false;
  private sending = false;

  constructor(
    private readonly api: WidgetApi,
    private readonly config: WidgetConfig,
    private readonly storageKey: string,
  ) {}

  mount(): void {
    const host = document.createElement("div");
    host.setAttribute("data-ai-receptionist", "");
    this.shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    this.shadow.appendChild(style);

    const theme =
      this.config.branding.theme === "auto"
        ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : this.config.branding.theme;

    const root = document.createElement("div");
    root.className = `root theme-${theme} ${
      this.config.branding.position === "bottom-left" ? "pos-left" : "pos-right"
    }`;
    root.style.setProperty("--ar-primary", this.config.branding.primaryColor);

    root.appendChild(this.buildPanel());
    root.appendChild(this.buildLauncher());
    this.shadow.appendChild(root);
    document.body.appendChild(host);

    this.visitorToken = sessionStorage.getItem(this.storageKey);
  }

  private buildLauncher(): HTMLButtonElement {
    this.launcher = document.createElement("button");
    this.launcher.className = "launcher";
    this.launcher.type = "button";
    this.launcher.setAttribute("aria-label", this.config.branding.launcherLabel);
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.setAttribute("aria-haspopup", "dialog");
    this.launcher.innerHTML = `${CHAT_ICON}<span>${escapeHtml(this.config.branding.launcherLabel)}</span>`;
    this.launcher.addEventListener("click", () => this.togglePanel());
    return this.launcher;
  }

  private buildPanel(): HTMLDivElement {
    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "false");
    this.panel.setAttribute("aria-label", `Chat with ${this.config.receptionistName}`);
    // Escape closes the panel, matching native dialog expectations.
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (this.panel.classList.contains("open")) this.togglePanel();
      }
    });

    const header = document.createElement("div");
    header.className = "header";
    header.innerHTML = `
      <div>
        <div class="title">${escapeHtml(this.config.receptionistName)}</div>
        <div class="subtitle">${escapeHtml(this.config.businessName)}</div>
      </div>`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.togglePanel());
    header.appendChild(closeBtn);

    this.messagesEl = document.createElement("div");
    this.messagesEl.className = "messages";
    this.messagesEl.setAttribute("aria-live", "polite");

    const composer = document.createElement("div");
    composer.className = "composer";

    this.inputEl = document.createElement("textarea");
    this.inputEl.rows = 1;
    this.inputEl.placeholder = "Type your message…";
    this.inputEl.setAttribute("aria-label", "Your message");
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.sendTyped();
      }
    });

    const sendBtn = document.createElement("button");
    sendBtn.className = "iconbtn";
    sendBtn.type = "button";
    sendBtn.setAttribute("aria-label", "Send message");
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.addEventListener("click", () => void this.sendTyped());

    composer.appendChild(this.inputEl);
    if (this.config.voiceEnabled && this.speech.isRecognitionSupported()) {
      this.micBtn = document.createElement("button");
      this.micBtn.className = "iconbtn mic";
      this.micBtn.type = "button";
      this.micBtn.setAttribute("aria-label", "Talk to the receptionist");
      this.micBtn.innerHTML = MIC_ICON;
      this.micBtn.addEventListener("click", () => this.toggleVoice());
      composer.appendChild(this.micBtn);
    }
    composer.appendChild(sendBtn);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "AI receptionist — answers may be imperfect.";

    this.panel.appendChild(header);
    this.panel.appendChild(this.messagesEl);
    this.panel.appendChild(composer);
    this.panel.appendChild(hint);
    return this.panel;
  }

  private togglePanel(): void {
    const open = this.panel.classList.toggle("open");
    this.launcher.setAttribute("aria-expanded", String(open));
    if (open) {
      if (this.messagesEl.childElementCount === 0) {
        this.addMessage("bot", this.config.greeting);
      }
      // Move focus into the dialog for keyboard and screen-reader users.
      this.inputEl.focus();
    } else {
      this.stopVoice();
      this.speech.cancelSpeech();
      // Return focus to the launcher that opened the dialog.
      this.launcher.focus();
    }
  }

  private resetConversation(): void {
    this.visitorToken = null;
    sessionStorage.removeItem(this.storageKey);
  }

  private async ensureConversation(channel: "chat" | "voice"): Promise<string> {
    if (this.visitorToken) return this.visitorToken;
    const session = await this.api.startConversation(channel);
    this.visitorToken = session.visitorToken;
    sessionStorage.setItem(this.storageKey, session.visitorToken);
    return session.visitorToken;
  }

  private async sendTyped(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.sending) return;
    this.inputEl.value = "";
    await this.send(text, "chat");
  }

  private async send(text: string, channel: "chat" | "voice"): Promise<void> {
    this.sending = true;
    this.addMessage("user", text);
    const typing = this.addMessage("bot typing", "…");

    try {
      let reply: string;
      try {
        const token = await this.ensureConversation(channel);
        ({ reply } = await this.api.sendMessage(token, text));
      } catch (error) {
        // A stored token can go stale (conversation ended, hit its message
        // limit, or was purged). Start fresh once instead of failing forever.
        if (
          error instanceof WidgetApiError &&
          (error.code === "CONFLICT" || error.code === "NOT_FOUND")
        ) {
          this.resetConversation();
          const token = await this.ensureConversation(channel);
          ({ reply } = await this.api.sendMessage(token, text));
        } else {
          throw error;
        }
      }
      typing.remove();
      this.addMessage("bot", reply);
      if (this.voiceMode) {
        this.speech.speak(reply, this.config.language, () => {
          // Hands-free loop: listen again after the receptionist finishes.
          if (this.voiceMode) this.startListening();
        });
      }
    } catch (error) {
      typing.remove();
      this.addMessage(
        "bot error",
        error instanceof Error ? error.message : "Something went wrong — please try again.",
      );
    } finally {
      this.sending = false;
    }
  }

  private toggleVoice(): void {
    if (this.voiceMode) {
      this.stopVoice();
    } else {
      this.voiceMode = true;
      this.startListening();
    }
  }

  private startListening(): void {
    if (!this.micBtn) return;
    this.micBtn.classList.add("listening");
    this.inputEl.placeholder = "Listening…";

    this.recognition = this.speech.startRecognition(this.config.language, {
      onResult: (transcript, isFinal) => {
        this.inputEl.value = transcript;
        if (isFinal && transcript) {
          this.inputEl.value = "";
          void this.send(transcript, "voice");
        }
      },
      onEnd: () => {
        this.micBtn?.classList.remove("listening");
        this.inputEl.placeholder = "Type your message…";
      },
      onError: (error) => {
        this.micBtn?.classList.remove("listening");
        this.inputEl.placeholder = "Type your message…";
        if (error === "not-allowed" || error === "service-not-allowed") {
          this.addMessage("bot error", "Microphone access was blocked — you can keep typing instead.");
          this.stopVoice();
        }
      },
    });
  }

  private stopVoice(): void {
    this.voiceMode = false;
    this.recognition?.stop();
    this.recognition = null;
    this.micBtn?.classList.remove("listening");
    this.inputEl.placeholder = "Type your message…";
  }

  private addMessage(kind: string, text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `msg ${kind}`;
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return el;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
