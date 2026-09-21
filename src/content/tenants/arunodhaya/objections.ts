/**
 * Arunodhaya Phase 4 — the objection catalog (brief §7).
 *
 * Cue lists cover Telugu script, transliterated Telugu and English, because
 * a caller in Hyderabad uses all three inside one sentence. They are matched
 * as normalized substrings, so "chala expensive andi" and "ఇది చాలా ఖరీదు"
 * both land on the same objection.
 *
 * `evidence` names facts in knowledge.ts. Every one of those facts is
 * currently `supplied_pending`, which means the agent is told, in the prompt,
 * that it has NO verified answer and must offer a person instead of arguing.
 * That is the intended behaviour today: an agent that answers "is it worth
 * it?" from general knowledge is inventing a financial claim about someone
 * else's business.
 *
 * Nothing here is a rebuttal script. Acknowledge, understand, answer only
 * from verified information, ask one question, and stop when the answer is
 * not landing.
 */
export const ARUNODHAYA_OBJECTIONS = {
  version: "arunodhaya-2026-09-21.1",
  language: "te-IN",
  objections: [
    {
      id: "too_expensive",
      cues: {
        "te-IN": [
          "చాలా ఖరీదు",
          "ఖరీదు ఎక్కువ",
          "డబ్బు ఎక్కువ",
          "ఖర్చు ఎక్కువ",
          "chala khareedu",
          "chala expensive",
          "cost ekkuva",
          "rate ekkuva",
          "price ekkuva",
          "chala costly",
        ],
        "en-IN": ["too expensive", "too costly", "price is high", "costs too much", "very expensive"],
      },
      acknowledge: {
        "te-IN": "నిజమే, ఇది మంచి మొత్తం పెట్టుబడి. మీరు ఆలోచించడం సహజం.",
        "en-IN": "That's fair — it is a real investment, and it's right to think about it.",
      },
      evidence: ["price_per_kw", "payback_facts", "subsidy", "financing_availability"],
      followUp: {
        "te-IN": "మీ నెల బిల్లు ఎంత వస్తుందో చెప్తే, మా టీమ్ మీకు సరైన లెక్క ఇస్తారు — చెప్తారా?",
        "en-IN": "If you tell me your monthly bill, our team can work out the real numbers for you — may I take it?",
      },
      escalateAfter: 2,
      endsQualification: false,
    },
    {
      id: "need_to_discuss",
      cues: {
        "te-IN": [
          "ఆయనతో మాట్లాడాలి",
          "ఆమెతో మాట్లాడాలి",
          "ఇంట్లో అడగాలి",
          "కుటుంబంతో మాట్లాడాలి",
          "husband tho matladali",
          "wife tho matladali",
          "family tho matladali",
          "intlo adagali",
        ],
        "en-IN": ["discuss with my husband", "discuss with my wife", "talk to my family", "ask at home", "check with my partner"],
      },
      acknowledge: {
        "te-IN": "తప్పకుండా, ఇలాంటి నిర్ణయం కలిసి తీసుకోవడమే మంచిది.",
        "en-IN": "Of course — a decision like this is better made together.",
      },
      evidence: [],
      followUp: {
        "te-IN": "మీ ఇద్దరికీ వీలైన సమయంలో మా టీమ్ ఫోన్ చేస్తారు — ఏ సమయం బాగుంటుంది?",
        "en-IN": "Our team can call when you're both free — what time would suit?",
      },
      escalateAfter: 1,
      endsQualification: false,
    },
    {
      id: "just_checking",
      cues: {
        "te-IN": ["ఊరికే అడుగుతున్నా", "చూస్తున్నాను", "ఇప్పుడే కాదు", "just checking", "chustunnanu", "urike adugutunna", "enquiry matrame"],
        "en-IN": ["just checking", "just enquiring", "just looking", "just curious", "no plans right now"],
      },
      acknowledge: {
        "te-IN": "సరే, ఏ ఇబ్బందీ లేదు. తెలుసుకోవడం మంచిదే.",
        "en-IN": "That's completely fine — it's good to know what's involved.",
      },
      evidence: [],
      followUp: {
        "te-IN": "మీ ఏరియాలో ఏం సాధ్యమో ఒక్క నిమిషంలో చెప్పగలను — ఏ ఏరియా అండి?",
        "en-IN": "I can tell you in a minute what's possible in your area — which area are you in?",
      },
      escalateAfter: 2,
      endsQualification: false,
    },
    {
      id: "already_have_quote",
      cues: {
        "te-IN": ["వేరే కోట్ ఉంది", "ఇంకొకరు చెప్పారు", "వేరే కంపెనీ", "already quote undi", "vere company", "inkokaru cheppuru"],
        "en-IN": ["already have a quote", "another company", "another vendor", "comparing quotes", "someone else quoted"],
      },
      acknowledge: {
        "te-IN": "మంచిది, పోల్చి చూడటం సరైన పని.",
        "en-IN": "Good — comparing is exactly the right thing to do.",
      },
      evidence: ["panel_brands", "panel_warranty", "system_types", "maintenance"],
      followUp: {
        "te-IN": "మా టీమ్ ఒకసారి చూసి, తేడా ఏంటో నిజాయితీగా చెప్తారు — ఒక సర్వేకి వీలవుతుందా?",
        "en-IN": "Our team can look at it and tell you honestly how it compares — would a site visit work?",
      },
      escalateAfter: 2,
      endsQualification: false,
    },
    {
      id: "no_budget",
      cues: {
        "te-IN": ["బడ్జెట్ లేదు", "డబ్బు లేదు", "ఇప్పుడు కుదరదు", "budget ledu", "dabbu ledu", "ippudu kudaradu"],
        "en-IN": ["no budget", "can't afford", "cannot afford", "not in my budget", "money is tight"],
      },
      acknowledge: {
        "te-IN": "అర్థమైంది, అలాంటప్పుడు తొందరపడాల్సిన అవసరం లేదు.",
        "en-IN": "Understood — there's no need to rush into it.",
      },
      evidence: ["financing_availability", "subsidy"],
      followUp: {
        "te-IN": "EMI లాంటి ఏమైనా వీలుందా అని మా టీమ్ చూసి చెప్తారు — వాళ్ళు ఫోన్ చేయమంటారా?",
        "en-IN": "Our team can check whether any payment option applies — shall I have them call you?",
      },
      escalateAfter: 1,
      endsQualification: false,
    },
    {
      id: "distrust",
      cues: {
        "te-IN": ["నమ్మకం లేదు", "మోసం", "సరిగా పని చేయదు", "nammakam ledu", "mosam", "fraud", "cheating", "pani cheyadu"],
        "en-IN": ["don't trust", "do not trust", "scam", "fraud", "cheated", "bad experience", "unreliable"],
      },
      acknowledge: {
        "te-IN": "మీ సందేహం సరైనదే. ఈ రంగంలో చెడు అనుభవాలు చాలా మందికి ఉన్నాయి.",
        "en-IN": "That's a fair concern — plenty of people have had bad experiences in this industry.",
      },
      evidence: ["panel_brands", "panel_warranty", "maintenance", "service_areas"],
      followUp: {
        "te-IN": "మా టీమ్ నుంచి ఒకరు నేరుగా మాట్లాడి మీ సందేహాలు తీరుస్తారు — కలపమంటారా?",
        "en-IN": "Someone from our team can answer that directly — shall I put you through?",
      },
      escalateAfter: 1,
      endsQualification: false,
    },
    {
      id: "call_later",
      cues: {
        "te-IN": ["తరువాత చేయండి", "ఇప్పుడు బిజీ", "తర్వాత మాట్లాడదాం", "tarvatha cheyandi", "later call cheyandi", "busy ga unnanu"],
        "en-IN": ["call later", "call me later", "busy right now", "not a good time", "call back later"],
      },
      acknowledge: {
        "te-IN": "సరే అండి, మీ సమయం చూసుకుని మాట్లాడదాం.",
        "en-IN": "No problem at all — we'll talk when it suits you.",
      },
      evidence: [],
      followUp: {
        "te-IN": "ఏ సమయంలో ఫోన్ చేస్తే బాగుంటుంది?",
        "en-IN": "What time would be better for you?",
      },
      escalateAfter: 1,
      // "Not now" means stop, not push harder.
      endsQualification: true,
    },
  ],
} as const;
