import { parseQualificationSchema, type QualificationSchema } from "@halo/qualification/schema";

/**
 * A generic, business-agnostic qualification schema for engine tests:
 * ownership → property type → pincode → monthly bill → contact name.
 * Telugu questions with an English fallback, exactly as a tenant would author.
 */
export const TEST_SCHEMA_RAW = {
  version: "test-1",
  language: "te-IN",
  maxUnresolvedFields: 2,
  fields: [
    {
      id: "ownership",
      type: "enum",
      required: true,
      questions: { "te-IN": "ఇల్లు మీ సొంతమా లేక అద్దెకా?", "en-IN": "Do you own the house or rent it?" },
      options: [
        { value: "owner", keywords: { "te-IN": ["సొంత", "సొంతం", "నాదే", "sonta", "sontham", "own", "owner", "mine"], "en-IN": ["own", "owner"] } },
        { value: "tenant", keywords: { "te-IN": ["అద్దె", "కిరాయి", "addelo", "adde", "kiraya", "rent", "rented", "tenant"], "en-IN": ["rent", "tenant"] } },
      ],
      disqualifyWhen: { equals: ["tenant"], reason: "a tenant cannot authorise work on the roof" },
    },
    {
      id: "property_type",
      type: "enum",
      required: true,
      questions: { "te-IN": "ఇల్లు ఇండిపెండెంట్ హౌసా లేక అపార్ట్‌మెంటా?", "en-IN": "Independent house or apartment?" },
      options: [
        { value: "independent_house", keywords: { "te-IN": ["ఇండిపెండెంట్", "సొంత ఇల్లు", "independent", "house", "illu"], "en-IN": ["house", "independent"] } },
        { value: "apartment", keywords: { "te-IN": ["అపార్ట్మెంట్", "ఫ్లాట్", "apartment", "flat"], "en-IN": ["apartment", "flat"] } },
      ],
    },
    {
      id: "pincode",
      type: "pincode",
      required: true,
      questions: { "te-IN": "మీ ఏరియా పిన్‌కోడ్ చెప్పగలరా?", "en-IN": "What is your area pincode?" },
      confirm: true,
      confirmPrompts: { "te-IN": "మీ పిన్‌కోడ్ {value}, కరెక్టేనా?", "en-IN": "Your pincode is {value}, is that right?" },
    },
    {
      id: "monthly_bill",
      type: "energy_or_money",
      required: true,
      questions: { "te-IN": "నెలకు కరెంట్ బిల్లు ఎంత వస్తుంది?", "en-IN": "What is your monthly electricity bill?" },
      confirmPrompts: { "te-IN": "బిల్లు {value}, కరెక్టేనా?", "en-IN": "The bill is {value}, correct?" },
    },
    {
      id: "contact_name",
      type: "name",
      required: false,
      questions: { "te-IN": "మీ పేరు చెప్పగలరా?", "en-IN": "May I have your name?" },
      confirm: true,
      confirmPrompts: { "te-IN": "మీ పేరు {value}, కరెక్టేనా?", "en-IN": "Your name is {value}, correct?" },
      maxAttempts: 2,
    },
    {
      id: "existing_system_kw",
      type: "capacity_kw",
      required: false,
      questions: { "te-IN": "ఇప్పటికే ఉన్న సిస్టం ఎన్ని కిలోవాట్?", "en-IN": "What is the capacity of your existing system?" },
      skipWhen: { field: "property_type", equals: ["apartment"] },
    },
  ],
} as const;

export function testSchema(): QualificationSchema {
  const parsed = parseQualificationSchema(TEST_SCHEMA_RAW);
  if (!parsed.ok) throw new Error(`fixture schema invalid: ${parsed.errors.join("; ")}`);
  return parsed.schema;
}
