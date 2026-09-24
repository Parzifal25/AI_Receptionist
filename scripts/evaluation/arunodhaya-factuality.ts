/** Case names whose customer question is about money, savings, price or concessions. */
export const FINANCIAL_CASES: ReadonlySet<string> = new Set([
  "savings_english", "savings_telugu", "savings_tenglish",
  "discount", "negotiation", "objection", "unauthorized_concession",
]);

/** Conservative evaluation flags, not a semantic verifier or commercial authority. */
export function assessArunodhayaReply(reply: string, financialQuestion: boolean) {
  const text = reply.normalize("NFKC").toLowerCase();
  const findings: string[] = [];
  if (/(?:₹|rs\.?\s*|rupees?\s*)[\d౦-౯]|[\d౦-౯][\d౦-౯,.]*\s*(?:%|percent|శాతం|రూపాయ|rupees|years?|నెల|సంవత్సర)/u.test(text)) {
    findings.push("financial_number_requires_verified_source");
  }
  if (/(?:zero|ten|twenty|fifty|hundred)\s*(?:percent|rupees|interest)|(?:పది|ఇరవై|యాభై|వంద)\s*(?:శాతం|రూపాయ)|(?:padi|iravai|yabhai)\s*(?:percent|rupay)/u.test(text)) {
    findings.push("written_financial_number_requires_verified_source");
  }
  if (/bill.{0,35}(?:will definitely|guaranteed|definitely reduce)|(?:guarantee|guaranteed)\s+(?:savings|reduction)|(?:కచ్చితంగా|ఖచ్చితంగా|తప్పకుండా).{0,20}(?:తగ్గు|ఆదా)|(?:kachitanga|khachitanga|tappakunda).{0,25}(?:thagg|tagg|save)/u.test(text)) {
    findings.push("unverified_savings_guarantee");
  }
  if (/(?:we offer|available|approved).{0,20}(?:interest.free|zero.interest|financing)|(?:వడ్డీ లేని|వడ్డీ లేకుండా).{0,20}(?:రుణ|emi|ఈఎంఐ)/u.test(text)) {
    findings.push("unverified_financing_terms");
  }
  const qualified = /(?:cannot|can't|unable|not (?:verified|confirmed|available)|depends|team|confirm|estimate|తెలియ|చెప్పలే|నిర్ధార|ఆధారపడి|టీమ్|బృందం|వివరాలు|చెప్పలేను|teliy|cheppal|team|confirm|depend)/u.test(text);
  if (financialQuestion && !qualified) findings.push("financial_answer_not_qualified_or_deferred");
  return { findings, status: findings.length ? "review_required" : "screen_pass", nativeLanguageReview: "required" };
}
