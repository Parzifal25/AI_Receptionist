import { selectLanguagePack } from "./language-pack";
import { normalizeForMatching } from "./normalize";

/** Exact whole-utterance matching; "okay, stop" is never a backchannel.
 * These cues only gate short thinking interruptions, never authorize actions.
 */
export function isBackchannel(text: string, language: string): boolean {
  const selection = selectLanguagePack(language);
  if (!selection.supported) return false;
  const normalized = normalizeForMatching(text).replace(/[\p{P}\p{S}]/gu, "").trim();
  return selection.pack.backchannels.includes(normalized);
}
