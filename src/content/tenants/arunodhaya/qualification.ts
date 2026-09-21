/**
 * Arunodhaya Phase 4 — the lead qualification configuration (brief §6).
 *
 * This is a STARTING configuration, not a business requirement. Nothing here
 * disqualifies a caller, because who does and does not qualify is
 * Arunodhaya's decision and they have not made it; `disqualifyWhen` is left
 * unset deliberately rather than filled with a guess (a wrong disqualifier
 * silently throws away real leads).
 *
 * Ordering is conversational, not bureaucratic: who you are, where you are,
 * what you have, what you spend, when you want it, how to reach you. The
 * engine asks ONE field at a time and never re-asks a filled one, and the
 * model's job is only to phrase the pending question naturally — which is
 * what keeps it from sounding like a form.
 *
 * Numbers and names are read back (`confirm: true`) because a misheard
 * phone number or bill amount is the one error that survives the call.
 */
export const ARUNODHAYA_QUALIFICATION = {
  version: "arunodhaya-2026-09-21.1",
  language: "te-IN",
  maxUnresolvedFields: 2,
  billRanges: {
    // Plausibility bounds for the amount-vs-units disambiguation, not prices.
    amountInr: { min: 200, max: 200_000 },
    unitsKwh: { min: 20, max: 20_000 },
  },
  fields: [
    {
      id: "name",
      type: "name",
      required: true,
      questions: { "te-IN": "మీ పేరు చెప్తారా?", "en-IN": "May I have your name?" },
      confirm: false,
      maxAttempts: 2,
    },
    {
      id: "location",
      type: "text",
      required: true,
      questions: {
        "te-IN": "మీరు ఏ ఏరియాలో ఉంటున్నారు?",
        "en-IN": "Which area are you in?",
      },
      confirm: false,
      maxAttempts: 2,
    },
    {
      id: "property_type",
      type: "enum",
      required: true,
      questions: {
        "te-IN": "ఇది సొంత ఇల్లా, అపార్ట్‌మెంటా, లేక షాప్ లేదా ఫ్యాక్టరీనా?",
        "en-IN": "Is it an independent house, an apartment, or a shop or factory?",
      },
      options: [
        {
          value: "independent_house",
          keywords: {
            "te-IN": ["సొంత ఇల్లు", "ఇండిపెండెంట్", "ఇల్లు", "sontha illu", "independent house", "own house", "villa"],
            "en-IN": ["independent", "house", "villa", "bungalow"],
          },
        },
        {
          value: "apartment",
          keywords: {
            "te-IN": ["అపార్ట్‌మెంట్", "ఫ్లాట్", "apartment", "flat", "apartment lo"],
            "en-IN": ["apartment", "flat"],
          },
        },
        {
          value: "commercial",
          keywords: {
            "te-IN": ["షాప్", "ఆఫీస్", "ఫ్యాక్టరీ", "బిజినెస్", "shop", "office", "factory", "business"],
            "en-IN": ["shop", "office", "factory", "commercial", "business"],
          },
        },
        {
          value: "agricultural",
          keywords: {
            "te-IN": ["పొలం", "వ్యవసాయం", "బోరు", "polam", "farm", "agriculture", "borewell"],
            "en-IN": ["farm", "agricultural", "borewell"],
          },
        },
      ],
      confirm: false,
      maxAttempts: 2,
    },
    {
      id: "ownership",
      type: "enum",
      required: true,
      questions: {
        "te-IN": "ఆ ఇల్లు మీ సొంతమా, లేక అద్దెకా?",
        "en-IN": "Do you own the property, or is it rented?",
      },
      options: [
        {
          value: "owner",
          keywords: {
            "te-IN": ["సొంతం", "నాదే", "own", "sontham", "naade", "owner"],
            "en-IN": ["own", "owner", "mine"],
          },
        },
        {
          value: "tenant",
          keywords: {
            "te-IN": ["అద్దె", "రెంట్", "adde", "rent", "tenant"],
            "en-IN": ["rent", "rented", "tenant", "lease"],
          },
        },
      ],
      // No `disqualifyWhen`: whether Arunodhaya sells to tenants is their
      // decision, not ours. Captured so a human can decide.
      confirm: false,
      maxAttempts: 2,
    },
    {
      id: "roof_availability",
      type: "enum",
      required: true,
      skipWhen: { field: "property_type", equals: ["apartment"] },
      questions: {
        "te-IN": "పైన డాబా లేదా షెడ్ మీద ఖాళీ స్థలం ఉందా?",
        "en-IN": "Is there open space on the terrace or roof?",
      },
      options: [
        {
          value: "available",
          keywords: {
            "te-IN": ["ఉంది", "ఖాళీ ఉంది", "డాబా ఉంది", "undi", "khali undi", "yes", "space undi"],
            "en-IN": ["yes", "available", "space", "terrace"],
          },
        },
        {
          value: "not_available",
          keywords: {
            "te-IN": ["లేదు", "ఖాళీ లేదు", "ledu", "no space", "no"],
            "en-IN": ["no", "not available", "no space"],
          },
        },
        {
          value: "not_sure",
          keywords: {
            "te-IN": ["తెలియదు", "చూడాలి", "teliyadu", "chudali", "not sure", "maybe"],
            "en-IN": ["not sure", "don't know", "need to check"],
          },
        },
      ],
      confirm: false,
      maxAttempts: 2,
    },
    {
      id: "monthly_bill",
      type: "energy_or_money",
      required: true,
      questions: {
        "te-IN": "మీ కరెంట్ బిల్లు నెలకి ఎంత వస్తుంది?",
        "en-IN": "Roughly how much is your monthly electricity bill?",
      },
      // Read back: a bill misheard as units (or the reverse) changes the
      // entire sizing conversation.
      confirm: true,
      confirmPrompts: {
        "te-IN": "సరే, నెలకి {value} అన్నారు కదా? సరైనదేనా?",
        "en-IN": "So that's {value} a month — is that right?",
      },
      maxAttempts: 3,
    },
    {
      id: "desired_capacity",
      type: "capacity_kw",
      // Most customers do not know this, and asking hard would be an
      // interrogation. Optional and never retried.
      required: false,
      questions: {
        "te-IN": "మీకు ఎన్ని కిలోవాట్ల సిస్టమ్ కావాలో ఏమైనా ఆలోచన ఉందా?",
        "en-IN": "Do you have a size in mind, in kilowatts?",
      },
      confirm: false,
      maxAttempts: 1,
    },
    {
      id: "timeline",
      type: "enum",
      required: true,
      questions: {
        "te-IN": "ఎప్పటిలోగా పెట్టించుకోవాలని అనుకుంటున్నారు?",
        "en-IN": "When are you hoping to get it installed?",
      },
      options: [
        {
          value: "immediate",
          keywords: {
            "te-IN": ["వెంటనే", "ఈ నెల", "త్వరగా", "ventane", "immediately", "this month", "asap"],
            "en-IN": ["immediately", "right away", "this month", "asap"],
          },
        },
        {
          value: "within_three_months",
          keywords: {
            "te-IN": ["రెండు మూడు నెలల్లో", "మూడు నెలలు", "two three months", "moodu nelalu", "few months"],
            "en-IN": ["two months", "three months", "few months", "this quarter"],
          },
        },
        {
          value: "later_this_year",
          keywords: {
            "te-IN": ["ఈ సంవత్సరం", "ఆరు నెలలు", "this year", "six months", "aaru nelalu"],
            "en-IN": ["this year", "six months", "later this year"],
          },
        },
        {
          value: "just_exploring",
          keywords: {
            "te-IN": ["ఇప్పుడే కాదు", "చూస్తున్నాను", "ఆలోచిస్తున్నాను", "just checking", "chustunnanu", "alochistunnanu"],
            "en-IN": ["just checking", "just exploring", "no plans", "someday"],
          },
        },
      ],
      confirm: false,
      maxAttempts: 2,
    },
    {
      id: "phone",
      type: "phone",
      required: true,
      questions: {
        "te-IN": "మా టీమ్ మీకు ఫోన్ చేయడానికి ఏ నంబర్ మంచిది?",
        "en-IN": "What's the best number for our team to reach you on?",
      },
      confirm: true,
      confirmPrompts: {
        "te-IN": "{value} — ఈ నంబర్ సరైనదేనా?",
        "en-IN": "{value} — have I got that right?",
      },
      maxAttempts: 3,
    },
    {
      id: "callback_preference",
      type: "time",
      required: false,
      questions: {
        "te-IN": "ఏ సమయంలో ఫోన్ చేస్తే మీకు వీలుగా ఉంటుంది?",
        "en-IN": "What time of day suits you best for a call?",
      },
      confirm: false,
      maxAttempts: 1,
    },
  ],
} as const;
