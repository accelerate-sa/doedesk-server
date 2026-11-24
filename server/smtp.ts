// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Sends one message through a mail submission server (Oracle Email Delivery in Jeddah), over SMTP
 * with STARTTLS and a user name and password. No dependencies: the conversation is short.
 *
 * Errors carry a `code` (`smtp_550`, `smtp_timeout`, `smtp_tls`, `smtp_connect`) and never the
 * recipient's address, so the code is all the service logs.
 */
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** starttls (port 587, the default), implicit (TLS from the first byte, port 465), none (tests only). */
  readonly security?: "starttls" | "implicit" | "none";
  /** The name this machine gives in EHLO. */
  readonly clientName?: string;
  readonly timeoutMs?: number;
  /** For tests against a server with a self-made certificate. Never set in production. */
  readonly allowSelfSigned?: boolean;
}

export interface OutgoingMessage {
  readonly to: string;
  readonly from: { readonly email: string; readonly name?: string };
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export class SmtpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** A header word in UTF-8: left alone when plain ASCII, else encoded as RFC 2047 asks, in short pieces. */
const encodeWord = (value: string): string => {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const pieces: Array<string> = [];
  let piece = "";
  for (const character of value) {
    if (Buffer.byteLength(piece + character, "utf8") > 39) {
      pieces.push(piece);
      piece = "";
    }
    piece += character;
  }
  if (piece !== "") pieces.push(piece);
  return pieces.map((part) => `=?UTF-8?B?${base64(part)}?=`).join("\r\n ");
};

const wrap76 = (value: string): string => value.replace(/(.{76})/g, "$1\r\n");

const clean = (value: string, what: string): string => {
  if (/[\r\n\0]/.test(value)) throw new SmtpError("smtp_invalid", `The ${what} holds a line break.`);
  return value;
};

/** The message as it goes on the wire: headers, then the text and the HTML as alternatives. */
export const buildMessage = (message: OutgoingMessage, messageId: string, date = new Date()): string => {
  const fromAddress = clean(message.from.email, "sender");
  const to = clean(message.to, "recipient");
  const name = message.from.name === undefined ? "" : clean(message.from.name, "sender name");
  const headers = [
    `From: ${name === "" ? fromAddress : `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeWord(name)} <${fromAddress}>`}`,
    `To: <${to}>`,
    `Subject: ${encodeWord(clean(message.subject, "subject"))}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    // Tells mail software this was sent by a machine, so it does not answer with an out-of-office note.
    "Auto-Submitted: auto-generated",
  ];
  const part = (type: string, body: string): string =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(base64(body))}\r\n`;
  if (message.html === undefined) return `${headers.join("\r\n")}\r\n${part("text/plain", message.text)}`;
  const boundary = `=_doedesk_${messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
  return (
    `${headers.join("\r\n")}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n${part("text/plain", message.text)}--${boundary}\r\n${part("text/html", message.html)}--${boundary}--\r\n`
  );
};

/** Reads the server's replies one at a time. A reply may span lines: `250-…` continues, `250 …` ends. */
const replyReader = (socket: Socket) => {
  let buffered = "";
  let waiting: { resolve: (reply: { code: number; text: string }) => void; reject: (cause: Error) => void } | null = null;
  let failed: Error | null = null;
  const deliver = (): void => {
    if (waiting === null) return;
    const lines = buffered.split("\r\n");
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (/^\d{3} /.test(lines[index] ?? "") || /^\d{3}$/.test(lines[index] ?? "")) {
        const reply = lines.slice(0, index + 1);
        buffered = lines.slice(index + 1).join("\r\n");
        const { resolve } = waiting;
        waiting = null;
        resolve({ code: Number((reply.at(-1) ?? "").slice(0, 3)), text: reply.join("\n") });
        return;
      }
    }
  };
  const fail = (cause: Error): void => {
    failed = cause;
    if (waiting !== null) {
      const { reject } = waiting;
      waiting = null;
      reject(cause);
    }
  };
  const onData = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8");
    deliver();
  };
  const onError = (cause: Error): void => fail(new SmtpError("smtp_connect", cause.message));
  const onClose = (): void => fail(new SmtpError("smtp_connect", "The mail server closed the connection."));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  return {
    next: (): Promise<{ code: number; text: string }> =>
      new Promise((resolve, reject) => {
        if (failed !== null) return reject(failed);
        waiting = { resolve, reject };
        deliver();
      }),
    detach: (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    },
  };
};

const opened = (socket: Socket, event: "connect" | "secureConnect"): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once("error", (cause: Error) => reject(new SmtpError(event === "connect" ? "smtp_connect" : "smtp_tls", cause.message)));
  });

export const sendMail = async (settings: SmtpSettings, message: OutgoingMessage): Promise<{ messageId: string }> => {
  const security = settings.security ?? "starttls";
  const timeoutMs = settings.timeoutMs ?? 20_000;
  const clientName = settings.clientName ?? "api.doedesk.com";
  const domain = message.from.email.split("@")[1] ?? "doedesk.com";
  const messageId = `${crypto.randomUUID()}@${domain}`;
  const data = buildMessage(message, messageId);
  const tlsOptions = { servername: settings.host, rejectUnauthorized: settings.allowSelfSigned !== true, minVersion: "TLSv1.2" as const };

  let socket: Socket =
    security === "implicit" ? connectTls({ host: settings.host, port: settings.port, ...tlsOptions }) : connectTcp({ host: settings.host, port: settings.port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const conversation = async (): Promise<void> => {
    await opened(socket, security === "implicit" ? "secureConnect" : "connect");
    let replies = replyReader(socket);
    const expect = async (codes: ReadonlyArray<number>, step: string): Promise<{ code: number; text: string }> => {
      const reply = await replies.next();
      // The server's words can repeat the recipient's address, so only its number is kept.
      if (!codes.includes(reply.code)) throw new SmtpError(`smtp_${reply.code}`, `The mail server answered ${reply.code} to ${step}.`);
      return reply;
    };
    const command = async (line: string, codes: ReadonlyArray<number>, step: string) => {
      socket.write(`${line}\r\n`);
      return expect(codes, step);
    };

    await expect([220], "the connection");
    let hello = await command(`EHLO ${clientName}`, [250], "EHLO");
    if (security === "starttls") {
      if (!/STARTTLS/i.test(hello.text)) throw new SmtpError("smtp_tls", "The mail server does not offer TLS.");
      await command("STARTTLS", [220], "STARTTLS");
      replies.detach();
      const secure = connectTls({ socket, ...tlsOptions });
      await opened(secure, "secureConnect");
      socket = secure;
      replies = replyReader(socket);
      hello = await command(`EHLO ${clientName}`, [250], "EHLO");
    }
    if (settings.username !== "") {
      if (security === "none" && settings.allowSelfSigned !== true) throw new SmtpError("smtp_tls", "A password is not sent without TLS.");
      await command(`AUTH PLAIN ${base64(`\0${settings.username}\0${settings.password}`)}`, [235], "the sign-in");
    }
    await command(`MAIL FROM:<${clean(message.from.email, "sender")}>`, [250], "MAIL FROM");
    await command(`RCPT TO:<${clean(message.to, "recipient")}>`, [250, 251], "RCPT TO");
    await command("DATA", [354], "DATA");
    // A line that starts with a dot gets a second one, so that it is not read as the end.
    socket.write(`${data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}\r\n.\r\n`);
    await expect([250], "the message");
    socket.write("QUIT\r\n");
  };
  try {
    await Promise.race([
      conversation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmtpError("smtp_timeout", "The mail server took too long.")), timeoutMs);
      }),
    ]);
    return { messageId };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
};
