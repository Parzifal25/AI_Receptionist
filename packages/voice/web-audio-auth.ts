import { createHmac } from "node:crypto";
export function signWebAudio(secret: string, body: string): string {
  return createHmac("sha256", secret).update("halo-web-stt-v1\n").update(body).digest("hex");
}
