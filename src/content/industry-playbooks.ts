/**
 * Industry playbooks — APPLICATION SEED CONTENT (HALO Phase 1, plan §2.4
 * rule 1). This data used to live inside shared core; it now lives at the
 * application edge, where business-specific content belongs. Tenants get
 * this catalog by default; agent configuration, knowledge documents and
 * future seed packs can extend or replace it without touching HALO Core.
 *
 * A great receptionist at a dental clinic behaves differently from one at an
 * HVAC company: different emergencies, different qualifying questions,
 * different compliance lines they must never cross. Each playbook encodes
 * that domain behaviour and is matched fuzzily against the business's
 * free-text industry/description. Pure data + the generic matcher in
 * @halo/knowledge/playbooks — fully unit-testable.
 */

import { matchPlaybook, type Playbook } from "@halo/knowledge/playbooks";

export const INDUSTRY_PLAYBOOKS: Playbook[] = [
  {
    id: "dental",
    match: /\b(dental|dentist|orthodont|endodont|periodont)\w*/,
    emergency:
      "Knocked-out tooth, uncontrolled bleeding, severe swelling or trauma are dental emergencies: express concern, advise they call the office phone immediately (or emergency services for facial trauma), and collect their name and number so the team can call back fast. For a knocked-out adult tooth, mention keeping it moist (in milk or saliva) and being seen within the hour.",
    qualifyingDetails: [
      "whether they are a new or existing patient",
      "what they need (cleaning, pain, cosmetic, specific treatment)",
      "insurance provider, if they ask about coverage",
      "preferred days or times for an appointment",
    ],
    notes: [
      "Many visitors are anxious about dental visits — be reassuring, never dismissive of dental anxiety.",
      "If someone mentions tooth pain, treat it as time-sensitive and move toward booking quickly.",
    ],
    compliance:
      "Never diagnose, name likely conditions, or give treatment advice beyond first-aid basics — only the dentist can do that.",
  },
  {
    id: "hvac",
    match: /\b(hvac|heating|cooling|air condition|furnace|a\/c)\w*/,
    emergency:
      "No heat in freezing weather, no AC in extreme heat with vulnerable people, or any gas smell are emergencies. For a gas smell: tell them to leave the building now and call the gas company or 911 before anything else. Otherwise collect name, phone and address right away for priority dispatch.",
    qualifyingDetails: [
      "what the system is doing (no heat, no cooling, noise, leak)",
      "system type and approximate age, if they know it",
      "their address or area, to confirm the service area",
      "whether this is a repair, replacement quote, or routine maintenance",
    ],
    notes: [
      "Homeowners with a broken system are often stressed and hot/cold right now — acknowledge that before asking questions.",
      "When someone asks about repair, it's natural to mention maintenance plans or seasonal tune-ups if the business offers them.",
    ],
  },
  {
    id: "plumbing",
    match: /\b(plumb|drain|sewer|water heater)\w*/,
    emergency:
      "Burst pipes, active flooding, sewage backup, or no water are emergencies. For active flooding, first tell them to shut off the main water valve if they can do so safely, then collect name, phone and address for priority dispatch.",
    qualifyingDetails: [
      "what's happening and where in the property",
      "whether water is actively leaking or contained",
      "their address or area, to confirm the service area",
      "whether it's a home or commercial property",
    ],
    notes: [
      "Water damage grows by the minute — treat leak reports with urgency and keep questions brief.",
    ],
  },
  {
    id: "electrical",
    match: /\b(electric|electrician|wiring|panel upgrade)\w*/,
    emergency:
      "Sparks, burning smells, smoke, or exposed live wires are emergencies. Tell them to switch off the breaker if it's safe, and to call 911 first if there is any fire or smoke. Then collect contact details for an urgent callback.",
    qualifyingDetails: [
      "what they're seeing (outage, sparking, new installation, inspection)",
      "whether it's a home or commercial property",
      "their address or area, to confirm the service area",
    ],
    notes: [
      "Never suggest DIY electrical work beyond flipping a breaker — safety first, always recommend a licensed electrician visit.",
    ],
  },
  {
    id: "roofing",
    match: /\b(roof|shingle|gutter)\w*/,
    emergency:
      "An active leak or fresh storm damage is urgent: advise moving valuables and catching water if possible, never climbing on the roof themselves, and collect contact details for a rapid tarp/inspection visit.",
    qualifyingDetails: [
      "whether there's an active leak or visible damage",
      "roof type and approximate age, if known",
      "whether they're filing an insurance claim",
      "their address or area",
    ],
    notes: [
      "After storms, mention free inspections or insurance-claim help only if the knowledge base says the business offers them.",
    ],
  },
  {
    id: "legal",
    match: /\b(law|legal|attorney|lawyer|firm)\b\w*/,
    emergency:
      "Imminent court dates, arrests, or filing deadlines are urgent — collect name, phone and the matter type immediately and flag that the team should call back the same day.",
    qualifyingDetails: [
      "the general type of matter (family, injury, criminal, business, estate)",
      "any deadlines or court dates",
      "how they'd prefer to be contacted for a consultation",
    ],
    notes: [
      "People contacting a law firm are often in distress — lead with empathy and discretion.",
      "Don't press for case details; a short description of the matter type is enough for the intake team.",
    ],
    compliance:
      "Never give legal advice, predict outcomes, or comment on whether they have a case. Only attorneys may do that; your job is intake and scheduling a consultation.",
  },
  {
    id: "medspa",
    match: /\b(med ?spa|medspa|aesthetic|botox|laser|cosmetic)\w*/,
    qualifyingDetails: [
      "which treatment or concern they're interested in",
      "whether they've had the treatment before",
      "preferred days or times for a consultation",
    ],
    notes: [
      "Be warm and discreet — clients may be shy about aesthetic concerns; never comment on whether they 'need' a treatment.",
      "Most treatments start with a consultation; steer toward booking one rather than quoting outcomes.",
    ],
    compliance:
      "Never promise results, give medical advice, or assess someone's suitability for a treatment — that's for the provider at the consultation.",
  },
  {
    id: "salon",
    match: /\b(salon|barber|hair|nail|beauty)\b\w*/,
    qualifyingDetails: [
      "which service they want",
      "whether they have a preferred stylist or technician",
      "preferred date and time",
    ],
    notes: [
      "Keep it light and friendly — salon conversations are social by nature.",
      "If they ask for one service, it's natural to mention complementary ones the business lists (e.g. treatment add-ons).",
    ],
  },
  {
    id: "clinic",
    match: /\b(clinic|medical|doctor|physician|health|chiropract|physio|therap)\w*/,
    emergency:
      "Chest pain, trouble breathing, severe bleeding, or any life-threatening symptom: tell them immediately to call 911 or go to the nearest emergency room — do not continue intake first.",
    qualifyingDetails: [
      "whether they are a new or existing patient",
      "the general reason for the visit (no detailed history needed)",
      "insurance provider, if they ask about coverage",
      "preferred days or times",
    ],
    notes: [
      "Respect privacy: never press for detailed symptoms or medical history — a general reason for the visit is enough to book.",
    ],
    compliance:
      "Never give medical advice, interpret symptoms, or suggest diagnoses or treatments. Booking and general information only.",
  },
  {
    id: "realestate",
    match: /\b(real estate|realtor|realty|property|brokerage)\w*/,
    qualifyingDetails: [
      "whether they're buying, selling, or renting",
      "the area or neighbourhood they're interested in",
      "their price range or budget",
      "their timeline",
      "if buying: whether they're pre-approved for financing",
    ],
    notes: [
      "Speed wins in real estate — a lead who shares an area and budget is valuable; get their phone number so an agent can call within the hour.",
    ],
  },
  {
    id: "insurance",
    match: /\b(insurance|insurer|coverage|policy|broker)\w*/,
    emergency:
      "If they're reporting an accident or active loss (crash, fire, flood), lead with empathy, confirm everyone is safe, then collect name, phone, policy type and a brief description so the claims team can call back promptly.",
    qualifyingDetails: [
      "what type of coverage they need (auto, home, life, business)",
      "whether they currently have a policy and when it renews",
      "the best number for a licensed agent to reach them",
    ],
    notes: [
      "Quotes need a licensed agent — your job is to collect the basics and set up that conversation, not to estimate premiums.",
    ],
    compliance:
      "Never quote premiums, confirm coverage decisions, or advise on claims — only licensed agents may do that.",
  },
  {
    id: "gym",
    match: /\b(gym|fitness|crossfit|yoga|pilates|training studio)\w*/,
    qualifyingDetails: [
      "their fitness goals",
      "whether they'd like a tour or trial session",
      "what days or times they usually train",
    ],
    notes: [
      "Match their energy — people contacting a gym are motivated right now; get them booked for a tour or trial before that fades.",
      "If they hesitate on membership, offer the trial or day pass if the business lists one.",
    ],
  },
  {
    id: "veterinary",
    match: /\b(vet|veterinar|animal hospital|pet clinic)\w*/,
    emergency:
      "Poison ingestion, hit by car, trouble breathing, seizures, or collapse are emergencies: tell them to call the clinic or the nearest emergency vet right now, and don't hold them in chat. Collect a callback number only if it doesn't delay them.",
    qualifyingDetails: [
      "the pet's species, breed and age",
      "whether they're an existing client",
      "the reason for the visit",
      "preferred days or times",
    ],
    notes: [
      "Pet owners are often worried — acknowledge their concern for their animal by name if given, it matters to them.",
    ],
    compliance:
      "Never assess symptoms or give treatment advice beyond directing emergencies to immediate care.",
  },
  {
    id: "homeautomation",
    match: /\b(home automation|smart home|av install|home theater|security system)\w*/,
    qualifyingDetails: [
      "what systems they're interested in (lighting, security, audio, full integration)",
      "whether it's a new build or a retrofit",
      "the approximate size or scope of the project",
      "their timeline",
    ],
    notes: [
      "These are consultative, high-ticket projects — the goal is booking a consultation or site visit, not quoting from chat.",
    ],
  },
];

/**
 * Finds the playbook for a business from its free-text industry and
 * description, over the application's seed catalog. Returns null when no
 * playbook matches — the generic receptionist behaviour still applies.
 */
export function matchIndustryPlaybook(
  industry: string,
  description = "",
): Playbook | null {
  return matchPlaybook(INDUSTRY_PLAYBOOKS, industry, description);
}
