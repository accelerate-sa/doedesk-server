// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { extension } from "./extension.ts";
import { requireAccepted } from "./acceptance.ts";
import { authenticate } from "./accounts.ts";
import { engineDetect, EngineError, type EngineKind } from "./engine.ts";
import { ApiError, type Env, json } from "./http.ts";
import { meter, meterQuietly, MONTHLY_DETECT_CHARACTERS, quotaExceeded, readUsage } from "./usage.ts";

const MAX_TEXTS_PER_REQUEST = 25;
const MAX_TEXT_LENGTH = 5000;

export const detect = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  await requireAccepted(env, account.userId);
  const body = (await request.json().catch(() => null)) as { texts?: unknown } | null;
  const texts = body?.texts;
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
    throw new ApiError(400, "invalid_request", "Send { texts: string[] }.");
  }
  const who = { userId: account.userId, client: account.client };
  if (texts.length > MAX_TEXTS_PER_REQUEST || texts.some((text: string) => text.length > MAX_TEXT_LENGTH)) {
    await meterQuietly(env, who, { detect_too_large: 1 });
    throw new ApiError(
      413,
      "too_large",
      `Send at most ${MAX_TEXTS_PER_REQUEST} texts of at most ${MAX_TEXT_LENGTH} characters each.`,
    );
  }
  const characters = (texts as ReadonlyArray<string>).reduce((total, text) => total + text.length, 0);
  // An allowance that is not the account's own is answered for by the layer that holds it.
  const shared = await extension().allowance?.(env, account, "detect");
  if (shared?.refusal !== undefined) {
    await meterQuietly(env, who, { detect_refused: 1 });
    throw shared.refusal;
  }
  if (shared === null || shared === undefined) {
    const usage = await readUsage(env, account.userId);
    if (usage.detectCharacters + characters > MONTHLY_DETECT_CHARACTERS) {
      await meterQuietly(env, who, { detect_refused: 1 });
      throw quotaExceeded();
    }
  }

  // Empty texts are not sent: nothing in them can be personal data. The rest go in one call, and
  // the answer has one result per text sent, in order.
  const results: Array<{ entities: Array<{ start: number; end: number; kind: EngineKind }> }> = texts.map(
    () => ({ entities: [] }),
  );
  const pending = (texts as ReadonlyArray<string>).flatMap((text, index) =>
    text.trim().length > 0 ? [{ text, index }] : [],
  );
  let units = 0;
  if (pending.length > 0) {
    try {
      const answer = await engineDetect(
        env,
        pending.map((item) => item.text),
      );
      units = answer.units;
      pending.forEach((item, position) => {
        results[item.index] = answer.results[position] ?? { entities: [] };
      });
    } catch (cause) {
      // A failed call may still have used some of the engine's work; the engine says how much, and
      // the meter counts it.
      await meterQuietly(env, who, { detect_failed: 1, detect_records: cause instanceof EngineError ? cause.units : 0 });
      throw cause;
    }
  }
  await meter(env, who, {
    detect_requests: 1,
    detect_texts: texts.length,
    detect_characters: characters,
    detect_records: units,
    detect_entities: results.reduce((total, result) => total + result.entities.length, 0),
  });
  return json({ results });
};
