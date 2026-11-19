import { requireAccepted } from "./acceptance.ts";
import { authenticate } from "./accounts.ts";
import { engineRead } from "./engine.ts";
import { ApiError, type Env, json } from "./http.ts";
import { meter, meterQuietly, MONTHLY_OCR_PAGES, quotaExceeded, readUsage } from "./usage.ts";

const MAX_OCR_BYTES = 20 * 1024 * 1024;

/** A PDF says so in its first bytes; the media type is the fallback. Anything else is an image. */
const isPdf = (bytes: ArrayBuffer, contentType: string): boolean => {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return (
    (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) ||
    contentType.toLowerCase().includes("pdf")
  );
};

export const ocr = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  await requireAccepted(env, account.userId);
  const who = { userId: account.userId, client: account.client };
  const usage = await readUsage(env, account.userId);
  if (usage.ocrPages >= MONTHLY_OCR_PAGES) {
    await meterQuietly(env, who, { ocr_refused: 1 });
    throw quotaExceeded();
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OCR_BYTES) {
    if (bytes.byteLength > 0) await meterQuietly(env, who, { ocr_too_large: 1 });
    throw new ApiError(413, "too_large", "Send one image or PDF of at most 20 MB.");
  }
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  // `?layout=1` asks where each word is, for a caller that covers words in the image itself.
  const withLayout = new URL(request.url).searchParams.get("layout") === "1";
  let result: Awaited<ReturnType<typeof engineRead>>;
  try {
    result = await engineRead(env, bytes, contentType, withLayout);
  } catch (cause) {
    // Whether the reader bills a file it gave up on is not something its answer says, so a failed
    // file adds no pages; the count of failures is what is kept.
    await meterQuietly(env, who, { ocr_failed: 1 });
    throw cause;
  }
  const pdf = isPdf(bytes, contentType);
  await meter(env, who, {
    ocr_files: 1,
    ocr_pages: result.pages,
    ocr_bytes: bytes.byteLength,
    ocr_pdf_files: pdf ? 1 : 0,
    ocr_pdf_pages: pdf ? result.pages : 0,
    ocr_pdf_bytes: pdf ? bytes.byteLength : 0,
  });
  // `layout` only when asked for and the engine gave one. A caller that needs it and does not get
  // it must not show the image; the app then sends the image's masked text instead.
  return json({ text: result.text, pages: result.pages, ...(withLayout && result.layout !== undefined ? { layout: result.layout } : {}) });
};
