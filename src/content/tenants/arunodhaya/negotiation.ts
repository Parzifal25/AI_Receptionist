/**
 * Arunodhaya Phase 4 — the commercial and negotiation policy (brief §8).
 *
 * READ THIS BEFORE CHANGING ANY NUMBER BELOW.
 *
 * Arunodhaya has supplied no verified commercial figures. Therefore:
 *
 *   priceDisclosure: "none"   — the agent may not state, estimate or imply
 *                               any price, subsidy, payback or saving.
 *   every discount value: null — which the authorization engine treats as
 *                               UNSET, not as the agent's discretion. No
 *                               discount can be offered by anyone.
 *   financing verified: false — so it is never mentioned.
 *
 * The result is an agent that qualifies, answers what it can verify, and
 * routes every commercial question to a person. That is the correct
 * behaviour, not a degraded one.
 *
 * To switch it on, Arunodhaya supplies figures, someone records who
 * confirmed them and when, the values replace the nulls, `priceDisclosure`
 * changes, and a NEW AGENT VERSION is published and evaluated
 * (docs/ARUNODHAYA_LEARNING_LOOP.md). Editing these numbers in place on a
 * live version is exactly the failure this structure exists to prevent.
 *
 * The one thing that IS authorized is the free site survey, and only because
 * `free_addon` carries no figure — it is a statement about process, not
 * about money. Even that is marked pending in knowledge.ts
 * (`site_visit_cost`), so if Arunodhaya does charge for surveys, this entry
 * must be removed before launch.
 */
export const ARUNODHAYA_NEGOTIATION = {
  version: "arunodhaya-2026-09-21.1",
  language: "te-IN",
  currency: "INR",
  priceDisclosure: "none",

  // No verified figures exist. An entry with a null amount is never quoted.
  quotes: [],

  concessions: [
    {
      id: "free_site_survey",
      label: { "te-IN": "ఉచిత సర్వే", "en-IN": "Free site survey" },
      type: "free_addon",
      value: null,
      conditions: [],
      // ⟨SUPPLIED⟩ Set to true if Arunodhaya charges for surveys.
      requiresApproval: false,
      script: {
        "te-IN": "మా టీమ్ ఒకసారి వచ్చి చూస్తారు, దానికి ఎటువంటి ఛార్జీ లేదు.",
        "en-IN": "Our team can come and take a look, and there's no charge for that visit.",
      },
      maxPerConversation: 1,
    },
    {
      id: "standard_discount",
      label: { "te-IN": "సాధారణ తగ్గింపు", "en-IN": "Standard discount" },
      type: "discount_percent",
      // ⟨SUPPLIED⟩ null until Arunodhaya authorizes a figure. Unavailable.
      value: null,
      conditions: [],
      requiresApproval: true,
      script: { "te-IN": "⟨SUPPLIED⟩", "en-IN": "⟨SUPPLIED⟩" },
      maxPerConversation: 1,
    },
    {
      id: "manager_approved_discount",
      label: { "te-IN": "మేనేజర్ ఆమోదించిన తగ్గింపు", "en-IN": "Manager-approved discount" },
      type: "discount_percent",
      // ⟨SUPPLIED⟩ null until Arunodhaya authorizes a figure. Unavailable.
      value: null,
      conditions: [],
      requiresApproval: true,
      script: { "te-IN": "⟨SUPPLIED⟩", "en-IN": "⟨SUPPLIED⟩" },
      maxPerConversation: 1,
    },
  ],

  floors: {
    // ⟨SUPPLIED⟩ No floor is configured, which is safe only because no
    // discount is authorized at all. Set both before authorizing any.
    minAmount: null,
    maxDiscountPercent: null,
  },

  financing: [
    {
      id: "emi",
      label: { "te-IN": "EMI", "en-IN": "EMI" },
      description: { "te-IN": "⟨SUPPLIED⟩", "en-IN": "⟨SUPPLIED⟩" },
      // Never mentioned until Arunodhaya confirms it exists and on what terms.
      verified: false,
    },
  ],

  escalation: {
    requestsBeforeHuman: 2,
    escalateOnUnlistedRequest: true,
    // ⟨SUPPLIED⟩ Meaningless while no discount is authorized; set it when one is.
    humanApprovalAbovePercent: null,
  },

  /**
   * Hard prohibitions, rendered verbatim into the prompt. These exist
   * because they are the specific promises a solar sales conversation
   * drifts towards, and every one of them is a claim about money or
   * government policy that this agent has no authority to make.
   */
  prohibitedPromises: [
    "ఎంత సబ్సిడీ వస్తుందో ఖచ్చితంగా చెప్పకండి — అది ప్రభుత్వ నిర్ణయం.",
    "ఎన్ని సంవత్సరాల్లో డబ్బు తిరిగి వస్తుందో హామీ ఇవ్వకండి.",
    "నెలకి ఎంత ఆదా అవుతుందో లెక్క చెప్పకండి.",
    "ఏ ధరా, ఏ తగ్గింపూ మీరే నిర్ణయించి చెప్పకండి.",
    "ఇన్‌స్టలేషన్ ఎప్పటికి పూర్తవుతుందో తేదీ ఇవ్వకండి.",
    "ఈ ఆఫర్ ఈరోజే అయిపోతుంది అని చెప్పకండి.",
    "Never state a price, discount, subsidy amount, payback period or monthly saving.",
    "Never say an offer expires today or that the customer must decide now.",
    "Never agree to a customer's number because they insisted.",
  ],
} as const;
