import { describe, expect, it } from "vitest";
import { resolveResponseLanguage, speechLanguageFor, type ResponseLanguage } from "@halo/language/response-language";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { CollectingEventSink } from "@halo/runtime/events";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { PhoneTurnHandler } from "@halo/voice/phone-channel-adapter";
import { emptyKnowledgeProvider, FakeConversationStore, makeAgent, reply, ScriptedLLM, type ScriptStep } from "../mocks/runtime-fakes";

/**
 * Phase A — the reply language is decided by the runtime, held in conversation
 * state, and reaches both the prompt and the synthesizer.
 *
 * Caller text is written the way the deployed recognizer (Sarvam, codemix)
 * delivers it: Telugu words in Telugu script, English words in Latin.
 */

const TELUGU = "సోలార్ ప్యానెల్ ధర ఎంత?";
const TENGLISH = "నాకు solar panel కావాలి";
const ENGLISH = "I want to know the price";

const resolve = (utterance: string, previous: ResponseLanguage | null = null) =>
  resolveResponseLanguage({ utterance, previous, primary: "te-IN", fallbacks: ["en-IN"], codeSwitchPolicy: "allow" });

function call(script: ScriptStep[]) {
  const llm = new ScriptedLLM(script);
  const stateStore = new InMemoryConversationStateStore();
  const sink = new CollectingEventSink();
  const agent = makeAgent();
  agent.config.language = { primary: "te-IN", fallbacks: ["en-IN"], codeSwitchPolicy: "allow" };
  const handler = new PhoneTurnHandler({
    agent,
    conversationId: "conv-lang",
    store: new FakeConversationStore(),
    llm,
    knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()),
    stateStore,
    events: sink,
    liveHandoffAvailable: false,
  });
  let turnIndex = 0;
  const say = (utterance: string) =>
    handler.handleTurn({ utterance, language: "te-IN", sttConfidence: null, turnIndex: turnIndex++, signal: new AbortController().signal });
  const languageRule = (callIndex: number) =>
    llm.calls[callIndex].systemPrompt.split("\n").filter((line) => /^- (Reply|Respond) /.test(line));
  const persisted = async () => (await stateStore.load("conv-lang", agent.business.id))?.responseLanguage;
  return { llm, sink, say, languageRule, persisted };
}

describe("response language: decision", () => {
  it.each([
    [TELUGU, { tag: "te-IN", mixed: false }],
    [ENGLISH, { tag: "en-IN", mixed: false }],
    [TENGLISH, { tag: "te-IN", mixed: true }],
    ["Solar panel price ఎంత?", { tag: "te-IN", mixed: true }],
    ["Price చెప్పండి", { tag: "te-IN", mixed: true }],
    // Romanized, as typed or as a transliterating recognizer delivers it.
    ["Naaku solar panel kavali", { tag: "te-IN", mixed: true }],
    ["Installation ki entha time padutundi?", { tag: "te-IN", mixed: true }],
  ])("%s", (utterance, expected) => {
    expect(resolve(utterance)).toEqual(expected);
  });

  it("does not leave Telugu for Latin words that are not an English sentence", () => {
    const telugu = { tag: "te-IN", mixed: false };
    for (const utterance of ["ok", "solar panel", "independent house", "survey free aa", "4000"]) {
      expect(resolve(utterance, telugu)).toEqual(telugu);
    }
  });

  it("does not read English words that begin like Telugu ones as Telugu", () => {
    expect(resolve("Can we have a meeting about the republic day offer")).toEqual({ tag: "en-IN", mixed: false });
  });

  it("decides nothing for an agent whose languages it cannot tell apart", () => {
    const base = { utterance: ENGLISH, previous: null, codeSwitchPolicy: "allow" as const };
    expect(resolveResponseLanguage({ ...base, primary: "en", fallbacks: [] })).toBeNull();
    expect(resolveResponseLanguage({ ...base, primary: "hi-IN", fallbacks: ["en-IN"] })).toBeNull();
  });

  it("speaks a line in the language it is actually written in", () => {
    expect(speechLanguageFor("The team will call you back.", "te-IN", ["en-IN"])).toBe("en-IN");
    expect(speechLanguageFor("మా టీమ్ మీకు call చేస్తారు.", "te-IN", ["en-IN"])).toBe("te-IN");
    // No English voice configured: stay on the one the tenant chose.
    expect(speechLanguageFor("The team will call you back.", "te-IN", [])).toBe("te-IN");
  });
});

describe("response language: prompt, state and synthesis", () => {
  it("Telugu input → Telugu reply language", async () => {
    const c = call([reply("ధర మీ అవసరాన్ని బట్టి ఉంటుంది.")]);
    const result = await c.say(TELUGU);
    expect(c.languageRule(0)).toEqual(["- Reply language for this turn (set by the system): Telugu, in Telugu script."]);
    expect(result.language).toBe("te-IN");
    expect(await c.persisted()).toEqual({ tag: "te-IN", mixed: false });
  });

  it("English input → English reply language", async () => {
    const c = call([reply("The price depends on what you need.")]);
    const result = await c.say(ENGLISH);
    expect(c.languageRule(0)).toEqual(["- Reply language for this turn (set by the system): English."]);
    expect(result.language).toBe("en-IN");
    expect(await c.persisted()).toEqual({ tag: "en-IN", mixed: false });
  });

  it("Tenglish input → Telugu mixed with English", async () => {
    const c = call([reply("తప్పకుండా, మీకు ఏ size solar panel కావాలి?")]);
    const result = await c.say(TENGLISH);
    expect(c.languageRule(0)).toEqual([
      "- Reply language for this turn (set by the system): casual spoken Telugu mixed with English, the way the caller speaks: Telugu words in Telugu script, and the English words the caller uses kept as English words in Latin letters, never translated or transliterated.",
    ]);
    expect(result.language).toBe("te-IN");
    expect(await c.persisted()).toEqual({ tag: "te-IN", mixed: true });
  });

  it("switches English → Telugu → English and holds through a one-word answer", async () => {
    const c = call([
      reply("Sure, what would you like to know?"),
      reply("ధర మీ అవసరాన్ని బట్టి ఉంటుంది."),
      reply("సరే."),
      reply("Installation timing depends on the site."),
    ]);
    const spoken = [];
    for (const utterance of [ENGLISH, TELUGU, "ok", "How long will installation take?"]) spoken.push((await c.say(utterance)).language);
    expect(spoken).toEqual(["en-IN", "te-IN", "te-IN", "en-IN"]);
    expect(c.sink.events.filter((e) => e.type === "language.resolved").map((e) => e.data.tag)).toEqual(["en-IN", "te-IN", "te-IN", "en-IN"]);
  });

  it("regenerates once when the model answers Telugu in English", async () => {
    const c = call([reply("The price depends on what you need."), reply("ధర మీ అవసరాన్ని బట్టి ఉంటుంది.")]);
    const result = await c.say(TELUGU);
    expect(result.reply).toBe("ధర మీ అవసరాన్ని బట్టి ఉంటుంది.");
    expect(result.language).toBe("te-IN");
    expect(c.llm.calls[1].systemPrompt).toMatch(/wrong language\. Write the same reply in Telugu, in Telugu script\./);
  });

  it("delivers a second wrong-language draft rather than the canned fallback, and speaks it in its own language", async () => {
    const c = call([reply("The price depends on what you need."), reply("It depends on your requirement.")]);
    const result = await c.say(TELUGU);
    expect(result.reply).toBe("It depends on your requirement.");
    expect(result.language).toBe("en-IN");
  });
});
