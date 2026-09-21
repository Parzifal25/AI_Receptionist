import { describe, expect, it } from "vitest";
import {
  exhaustedObjections,
  matchObjections,
  parseObjectionCatalog,
  recordObjections,
} from "@halo/negotiation/objections";
import { NegotiationSystemActionProvider } from "@halo/negotiation/system-action";
import { emptyNegotiationPolicy, parseNegotiationPolicy } from "@halo/negotiation/policy";
import type { SystemActionInput } from "@halo/runtime/system-actions";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import { BUSINESS_A } from "../../mocks/runtime-fakes";

const catalog = (() => {
  const parsed = parseObjectionCatalog({
    version: "test-1",
    language: "te-IN",
    objections: [
      {
        id: "too_expensive",
        cues: {
          "te-IN": ["చాలా ఖరీదు", "chala expensive", "ekkuva rate", "డబ్బు ఎక్కువ"],
          "en-IN": ["too expensive", "too costly", "price is high"],
        },
        acknowledge: { "te-IN": "అర్థమైంది, ఖర్చు ముఖ్యమే." },
        evidence: ["payback_facts"],
        followUp: { "te-IN": "మీ నెల బిల్లు ఎంత వస్తుంది?" },
        escalateAfter: 2,
      },
      {
        id: "ask_spouse",
        cues: { "te-IN": ["ఆయనతో మాట్లాడాలి", "husband tho matladali", "wife ni adagali"] },
        acknowledge: { "te-IN": "తప్పకుండా, కలిసి నిర్ణయించుకోండి." },
        evidence: [],
        escalateAfter: 1,
      },
      {
        id: "call_later",
        cues: { "te-IN": ["తరువాత చేయండి", "later call cheyandi"] },
        acknowledge: { "te-IN": "సరే, మీకు వీలైనప్పుడు మాట్లాడదాం." },
        endsQualification: true,
        escalateAfter: 1,
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.catalog;
})();

const input = (userMessage: string): SystemActionInput => ({
  trusted: { businessId: BUSINESS_A.id, conversationId: "c1", agentId: "a1", agentVersionId: "v1", turnId: "t1" },
  business: BUSINESS_A,
  history: [],
  userMessage,
  state: emptyConversationState(),
  now: new Date("2026-09-21T10:00:00Z"),
});

describe("objection detection", () => {
  it("matches Telugu script, transliterated Telugu and English cues", () => {
    expect(matchObjections("ఇది చాలా ఖరీదు అండి", catalog)[0]?.objection.id).toBe("too_expensive");
    expect(matchObjections("sir idi chala expensive ga undi", catalog)[0]?.objection.id).toBe("too_expensive");
    expect(matchObjections("honestly it is too expensive for us", catalog)[0]?.objection.id).toBe("too_expensive");
  });

  it("matches a code-switched sentence, which is how people actually speak", () => {
    const matches = matchObjections("naaku interest undi kani price is high andi", catalog);
    expect(matches[0]?.objection.id).toBe("too_expensive");
  });

  it("returns nothing for an utterance with no objection in it", () => {
    expect(matchObjections("నా పేరు రమేష్", catalog)).toEqual([]);
    expect(matchObjections("", catalog)).toEqual([]);
  });

  it("counts repeats and reports an objection whose budget is spent", () => {
    let history = {};
    history = recordObjections(history, matchObjections("chala expensive", catalog));
    history = recordObjections(history, matchObjections("still too expensive", catalog));
    expect(exhaustedObjections(history, catalog)).toEqual([]);
    history = recordObjections(history, matchObjections("price is high", catalog));
    expect(exhaustedObjections(history, catalog).map((o) => o.id)).toEqual(["too_expensive"]);
  });

  it("refuses a catalog with no cues or acknowledgement in its own language", () => {
    const parsed = parseObjectionCatalog({
      version: "bad",
      language: "te-IN",
      objections: [{ id: "x", cues: { "en-IN": ["nope"] }, acknowledge: { "en-IN": "ok" } }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected refusal");
    expect(parsed.errors.join(" ")).toContain('no cues in "te-IN"');
  });
});

describe("negotiation ground truth", () => {
  const policy = (() => {
    const parsed = parseNegotiationPolicy({
      version: "p1",
      language: "te-IN",
      priceDisclosure: "none",
      concessions: [
        {
          id: "site_visit_free",
          label: { "te-IN": "ఉచిత సర్వే" },
          type: "free_addon",
          value: null,
          requiresApproval: false,
          script: { "te-IN": "సర్వే ఉచితం, ఎటువంటి ఛార్జీ లేదు." },
        },
      ],
      prohibitedPromises: ["సబ్సిడీ ఎంత వస్తుందో హామీ ఇవ్వకండి"],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.policy;
  })();

  it("tells the model exactly what it may offer and forbids inventing anything else", async () => {
    const provider = new NegotiationSystemActionProvider({ policy, catalog });
    const outcome = await provider.prepare(input("idi chala expensive"));
    const section = outcome!.sections[0];

    expect(section).toContain("too_expensive");
    expect(section).toContain("అర్థమైంది, ఖర్చు ముఖ్యమే.");
    expect(section).toContain("payback_facts");
    expect(section).toContain("సర్వే ఉచితం, ఎటువంటి ఛార్జీ లేదు.");
    expect(section).toContain("NO approved price figures");
    expect(section).toContain("సబ్సిడీ ఎంత వస్తుందో హామీ ఇవ్వకండి");
  });

  it("says plainly that nothing is authorized when the policy is empty", async () => {
    const provider = new NegotiationSystemActionProvider({ policy: emptyNegotiationPolicy("te-IN"), catalog });
    const section = (await provider.prepare(input("chala expensive")))!.sections[0];
    expect(section).toContain("Nothing is authorized for you to offer");
    expect(section).toContain("Do not invent a discount");
  });

  it("stops re-answering an objection the customer keeps raising and offers a person", async () => {
    const provider = new NegotiationSystemActionProvider({ policy, catalog });
    await provider.prepare(input("too expensive"));
    await provider.prepare(input("still too expensive"));
    const section = (await provider.prepare(input("price is high")))!.sections[0];
    expect(section).toContain("your answer is not landing");
    expect(section).toContain("offer to have a person call them");
  });

  it("closes politely rather than qualifying when the objection means 'not now'", async () => {
    const provider = new NegotiationSystemActionProvider({ policy, catalog });
    const section = (await provider.prepare(input("later call cheyandi")))!.sections[0];
    expect(section).toContain("This means 'not now'");
    expect(section).toContain("do not push");
  });

  it("is honest when it has no verified answer for an objection", async () => {
    const provider = new NegotiationSystemActionProvider({ policy, catalog });
    const section = (await provider.prepare(input("husband tho matladali")))!.sections[0];
    expect(section).toContain("no verified information configured");
    expect(section).toContain("rather than answering from general knowledge");
  });

  it("counts pushes in conversation state so escalation is measurable later", async () => {
    const provider = new NegotiationSystemActionProvider({ policy, catalog });
    const first = await provider.prepare(input("too expensive"));
    expect(first!.statePatch?.slots).toMatchObject({ negotiation_requests: "1", last_objection: "too_expensive" });
    const second = await provider.prepare(input("still too costly"));
    expect(second!.statePatch?.slots).toMatchObject({ negotiation_requests: "2" });
  });
});
