/*
 * cli/src/secrets/global/smtp-auth.ts — prove an SMTP username/password
 * pair authenticates, without sending anything.
 *
 * Dialogue: greeting → EHLO → STARTTLS → (TLS) EHLO → AUTH PLAIN → QUIT.
 * The session ends before MAIL FROM, so no message is ever queued. Used
 * to check a rotated SES key's derived SMTP password against
 * `email-smtp.<region>.amazonaws.com:587` before the old key goes.
 *
 * The password travels only inside the TLS session and is never echoed
 * into an error: failures report the SMTP reply code and the phase.
 */

import { type Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface SmtpAuthOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** `starttls` (SES on 587, the default) or `none` (tests against a
   *  local plain-text server). */
  tls?: "starttls" | "none";
  timeoutMs?: number;
}

export type SmtpAuthResult =
  | { ok: true }
  | { ok: false; phase: string; code?: number; detail: string };

/** Read SMTP replies line by line; a reply ends on `NNN ` (space). */
class ReplyReader {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<(reply: { code: number }) => void> = [];
  /** Replies that arrived before anyone asked (the greeting usually does). */
  private queued: Array<{ code: number }> = [];

  feed(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)) };
        this.lines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter(reply);
        else this.queued.push(reply);
      }
      nl = this.buffer.indexOf("\n");
    }
  }

  next(): Promise<{ code: number }> {
    const ready = this.queued.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export async function checkSmtpAuth(opts: SmtpAuthOptions): Promise<SmtpAuthResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let socket: Socket | undefined;
  let phase = "connect";
  const timer = new Promise<SmtpAuthResult>((resolve) => {
    setTimeout(
      () => resolve({ ok: false, phase, detail: `timed out after ${timeoutMs}ms` }),
      timeoutMs,
    ).unref();
  });

  const dialogue = (async (): Promise<SmtpAuthResult> => {
    let reader = new ReplyReader();
    socket = netConnect({ host: opts.host, port: opts.port });
    socket.setEncoding("utf-8");
    // Persistent listener: a late error (a reset after QUIT) must not
    // surface as an unhandled 'error' event.
    const failed = new Promise<SmtpAuthResult>((resolve) => {
      socket?.on("error", (err) => resolve({ ok: false, phase, detail: err.message }));
    });
    const attach = (s: Socket) => s.on("data", (d: string | Buffer) => reader.feed(String(d)));
    attach(socket);

    const expect = async (codes: number[]): Promise<SmtpAuthResult | undefined> => {
      const reply = await Promise.race([reader.next(), failed]);
      if ("ok" in reply) return reply;
      if (!codes.includes(reply.code)) {
        return { ok: false, phase, code: reply.code, detail: `server answered ${reply.code}` };
      }
      return undefined;
    };
    const send = (line: string) => socket?.write(`${line}\r\n`);

    phase = "greeting";
    let bad = await expect([220]);
    if (bad) return bad;
    phase = "ehlo";
    send("EHLO hatchkit-rotate");
    bad = await expect([250]);
    if (bad) return bad;

    if ((opts.tls ?? "starttls") === "starttls") {
      phase = "starttls";
      send("STARTTLS");
      bad = await expect([220]);
      if (bad) return bad;
      const plain = socket;
      plain.removeAllListeners("data");
      reader = new ReplyReader();
      const secure = tlsConnect({ socket: plain, servername: opts.host });
      secure.setEncoding("utf-8");
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", () => resolve());
        secure.once("error", reject);
      });
      secure.on("error", () => undefined); // reported via the timer / next expect
      socket = secure;
      attach(secure);
      phase = "ehlo-tls";
      send("EHLO hatchkit-rotate");
      bad = await expect([250]);
      if (bad) return bad;
    }

    phase = "auth";
    const token = Buffer.from(`\u0000${opts.username}\u0000${opts.password}`, "utf-8").toString(
      "base64",
    );
    send(`AUTH PLAIN ${token}`);
    bad = await expect([235]);
    if (bad) return bad;

    phase = "quit";
    send("QUIT");
    return { ok: true };
  })().catch(
    (err: unknown): SmtpAuthResult => ({
      ok: false,
      phase,
      detail: err instanceof Error ? err.message : String(err),
    }),
  );

  try {
    return await Promise.race([dialogue, timer]);
  } finally {
    socket?.destroy();
  }
}
