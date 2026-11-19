// A mail submission server for tests: speaks enough SMTP to take one message per connection, with
// STARTTLS on a certificate made for the run. Stands in for Oracle Email Delivery.
//
//   node server/test/smtp-stub.mjs <folder>
//
// Prints {"port": N} when it listens. Each message it accepts is appended to <folder>/messages.jsonl
// as { tls, user, password, from, to, data }. Behaviour is switched by STUB_MODE:
//   (unset)       offers STARTTLS, wants AUTH PLAIN, accepts
//   reject        refuses the recipient with 550, repeating the address as real servers do
//   no-starttls   does not offer STARTTLS
//   silent        accepts the connection and never speaks
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

const folder = process.argv[2];
const mode = process.env.STUB_MODE ?? "";
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(folder, "key.pem"), "-out", join(folder, "cert.pem"), "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
const context = createSecureContext({ key: readFileSync(join(folder, "key.pem")), cert: readFileSync(join(folder, "cert.pem")) });

const server = createServer((raw) => {
  if (mode === "silent") return;
  let socket = raw;
  const session = { tls: false, user: null, password: null, from: null, to: null };
  let buffered = "";
  let inData = false;
  const say = (line) => socket.write(`${line}\r\n`);
  const onData = (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buffered.indexOf("\r\n.\r\n");
        if (end === -1) return;
        const data = buffered.slice(0, end).replace(/^\.\./gm, ".");
        buffered = buffered.slice(end + 5);
        inData = false;
        appendFileSync(join(folder, "messages.jsonl"), `${JSON.stringify({ ...session, data })}\n`);
        say("250 2.0.0 queued");
        continue;
      }
      const lineEnd = buffered.indexOf("\r\n");
      if (lineEnd === -1) return;
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 2);
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") {
        socket.write(`250-stub\r\n${!session.tls && mode !== "no-starttls" ? "250-STARTTLS\r\n" : ""}250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`);
      } else if (verb === "STARTTLS") {
        say("220 2.0.0 ready");
        socket.removeListener("data", onData);
        socket = new TLSSocket(socket, { isServer: true, secureContext: context });
        session.tls = true;
        socket.on("data", onData);
        socket.on("error", () => {});
      } else if (verb === "AUTH") {
        const [, user, password] = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").split("\0");
        session.user = user;
        session.password = password;
        say(user === "stub-user" && password === "stub-password" ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
      } else if (verb === "MAIL") {
        session.from = /<(.*)>/.exec(line)?.[1] ?? null;
        say("250 2.1.0 ok");
      } else if (verb === "RCPT") {
        session.to = /<(.*)>/.exec(line)?.[1] ?? null;
        say(mode === "reject" ? `550 5.1.1 <${session.to}> no such mailbox` : "250 2.1.5 ok");
      } else if (verb === "DATA") {
        inData = true;
        say("354 go ahead");
      } else if (verb === "QUIT") {
        say("221 2.0.0 bye");
        socket.end();
      } else say("500 5.5.1 what");
    }
  };
  socket.on("data", onData);
  socket.on("error", () => {});
  say("220 stub ESMTP");
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
process.on("SIGTERM", () => process.exit(0));
