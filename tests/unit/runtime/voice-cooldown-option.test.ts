import { describe, expect, it } from "vitest";
import { PHONE_VOICE_PROFILE, WEB_CHAT_PROFILE, WEB_VOICE_PROFILE } from "@halo/runtime/channel-profile";
import { makeInput, makeRuntime, reply, ScriptedLLM } from "../../mocks/runtime-fakes";

/** W4.6: the runtime asks the router not to sleep on cooldowns for voice turns only. */
describe("maxCooldownWaitMs per channel (W4.6)", () => {
  it.each([
    [WEB_VOICE_PROFILE.id, WEB_VOICE_PROFILE, 0],
    [PHONE_VOICE_PROFILE.id, PHONE_VOICE_PROFILE, 0],
    [WEB_CHAT_PROFILE.id, WEB_CHAT_PROFILE, undefined],
  ])("%s", async (_id, channel, expected) => {
    const llm = new ScriptedLLM([reply("Sure.")]);
    const { runtime } = makeRuntime({ llm });
    await runtime.run(makeInput({ channel, userMessage: "When are you open?" }));
    expect(llm.calls[0].options.maxCooldownWaitMs).toBe(expected);
  });
});
