import { afterEach, expect, it, vi } from "vitest";
import { LogMessagingProvider } from "@halo/providers/messaging/log-messaging-provider";

afterEach(() => vi.restoreAllMocks());

it("records simulation metadata without recipient, content or attachment names", async () => {
  const sink = vi.spyOn(console, "log").mockImplementation(() => {});
  await new LogMessagingProvider().send({
    channel: "email",
    to: "synthetic-private@example.invalid",
    subject: "private subject",
    body: "private message",
    html: "<p>private html</p>",
    attachments: [{ filename: "private-record.txt", contentType: "text/plain", content: "private attachment" }],
  });
  const output = JSON.stringify(sink.mock.calls);
  for (const value of ["synthetic-private", "private subject", "private message", "private html", "private-record", "private attachment"]) {
    expect(output).not.toContain(value);
  }
  expect(JSON.parse(sink.mock.calls[0][0])).toMatchObject({
    channel: "email", delivery: "simulated", hasHtml: true, attachmentCount: 1,
  });
});
