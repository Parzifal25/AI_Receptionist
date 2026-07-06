import { WidgetApi } from "./api";
import { ReceptionistWidget } from "./widget";

/**
 * Widget bootstrap. Loaded via:
 *   <script src="https://app.example.com/widget.js" data-key="..." async></script>
 *
 * Fails silently on misconfiguration (a broken widget must never break the
 * host page) but logs a console hint for the installing developer.
 */
(function bootstrap() {
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>("script[data-key][src*='widget']");

  if (!script) return;

  const widgetKey = script.dataset.key;
  if (!widgetKey) {
    console.warn("[ai-receptionist] missing data-key attribute on widget script tag");
    return;
  }

  // The API lives on the same origin the script was served from.
  const baseUrl = new URL(script.src).origin;

  const start = async () => {
    try {
      const api = new WidgetApi(baseUrl, widgetKey);
      const config = await api.getConfig();
      const widget = new ReceptionistWidget(api, config, `ar_conversation_${widgetKey}`);
      widget.mount();
    } catch (error) {
      console.warn("[ai-receptionist] widget failed to load", error);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
  } else {
    void start();
  }
})();
