import { describe, expect, it } from "vitest";
import {
  createOAuthNonce,
  decodeOAuthState,
  encodeOAuthState,
} from "@/lib/oauth-state";

const SECRET = "test-secret";

describe("oauth-state", () => {
  it("round-trips an authentic state", () => {
    const nonce = createOAuthNonce();
    const state = encodeOAuthState({ businessId: "b1", nonce }, SECRET);
    const payload = decodeOAuthState(state, SECRET);
    expect(payload?.businessId).toBe("b1");
    expect(payload?.nonce).toBe(nonce);
  });

  it("rejects tampered payloads and wrong secrets", () => {
    const state = encodeOAuthState({ businessId: "b1", nonce: "n" }, SECRET);
    const [encoded, sig] = state.split(".");

    // Re-point the state at another business without re-signing.
    const forged = Buffer.from(
      JSON.stringify({ businessId: "b2", nonce: "n", issuedAt: Date.now() }),
    ).toString("base64url");
    expect(decodeOAuthState(`${forged}.${sig}`, SECRET)).toBeNull();

    expect(decodeOAuthState(state, "other-secret")).toBeNull();
    expect(decodeOAuthState(encoded, SECRET)).toBeNull(); // no signature at all
    expect(decodeOAuthState("", SECRET)).toBeNull();
  });

  it("expires states after the TTL", () => {
    const state = encodeOAuthState({ businessId: "b1", nonce: "n" }, SECRET);
    expect(decodeOAuthState(state, SECRET, Date.now() + 11 * 60_000)).toBeNull();
    expect(decodeOAuthState(state, SECRET, Date.now() + 5 * 60_000)).not.toBeNull();
  });

  it("rejects states issued in the future", () => {
    const state = encodeOAuthState({ businessId: "b1", nonce: "n" }, SECRET);
    expect(decodeOAuthState(state, SECRET, Date.now() - 2 * 60_000)).toBeNull();
  });

  it("generates unique nonces", () => {
    expect(createOAuthNonce()).not.toBe(createOAuthNonce());
  });
});
