// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { MARK_SVG } from "./brand.ts";
import { escapeHtml } from "./http.ts";

type Locale = "en" | "ar";

const COPY = {
  en: {
    subject: "Sign in to DoeDesk",
    heading: "Sign in to DoeDesk",
    button: "Sign in",
    note: "This link works for 15 minutes. If you did not ask for it, ignore this email.",
    askTitle: "Sign in to DoeDesk?",
    confirm: "Confirm sign-in",
    askNote: "Only confirm if you just asked to sign in.",
    doneTitle: "You are signed in",
    doneBody: "Return to DoeDesk. You can close this tab.",
    expiredTitle: "This link has expired",
    expiredBody: "Ask for a new one in DoeDesk.",
    from: "Request from",
    openTitle: "Opening your sign-in link",
    openBody: "If nothing happens, turn on JavaScript for this page, or ask for a new link in DoeDesk.",
    movingTitle: "Back in a few minutes",
    movingBody: "DoeDesk Cloud is moving to new servers. Open the link again in a few minutes.",
  },
  ar: {
    subject: "تسجيل الدخول إلى DoeDesk",
    heading: "تسجيل الدخول إلى DoeDesk",
    button: "تسجيل الدخول",
    note: "يصلح هذا الرابط لمدة 15 دقيقة. إن لم تطلبه فتجاهل هذه الرسالة.",
    askTitle: "تسجيل الدخول إلى DoeDesk؟",
    confirm: "تأكيد الدخول",
    askNote: "أكّد فقط إن كنت قد طلبت تسجيل الدخول الآن.",
    doneTitle: "تم تسجيل دخولك",
    doneBody: "ارجع إلى DoeDesk. يمكنك إغلاق هذه الصفحة.",
    expiredTitle: "انتهت صلاحية الرابط",
    expiredBody: "اطلب رابطًا جديدًا من DoeDesk.",
    from: "الطلب من",
    openTitle: "جارٍ فتح رابط الدخول",
    openBody: "إن لم يحدث شيء ففعّل JavaScript لهذه الصفحة، أو اطلب رابطًا جديدًا من DoeDesk.",
    movingTitle: "نعود بعد دقائق",
    movingBody: "ننقل DoeDesk Cloud إلى خوادم جديدة. افتح الرابط مرة أخرى بعد بضع دقائق.",
  },
} as const;

const FONT = "'IBM Plex Sans Arabic','IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif";

export const signInEmail = (link: string, locale: Locale) => {
  const copy = COPY[locale];
  const direction = locale === "ar" ? "rtl" : "ltr";
  const safeLink = escapeHtml(link);
  return {
    subject: copy.subject,
    text: `${copy.heading}\n\n${link}\n\n${copy.note}\n`,
    html: `<!doctype html>
<html lang="${locale}" dir="${direction}"><body style="margin:0;background:#F5F3EE;font-family:${FONT};color:#171815">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EE"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#FFFFFF;border:1px solid #DDD9CF;border-radius:14px"><tr><td style="padding:32px">
<div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#171815">DoeDesk</div>
<h1 style="margin:24px 0 20px;font-size:22px;line-height:1.25;font-weight:600">${copy.heading}</h1>
<a href="${safeLink}" style="display:inline-block;background:#96531F;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:500;padding:12px 22px;border-radius:10px">${copy.button}</a>
<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#5C5E56">${copy.note}</p>
</td></tr></table>
</td></tr></table>
</body></html>`,
  };
};

type ConfirmState =
  | { readonly state: "expired" | "done" | "open" | "moving"; readonly locale: Locale }
  | {
      readonly state: "ask";
      readonly locale: Locale;
      readonly requestId: string;
      readonly token: string;
      readonly device: string | null;
      readonly place: string | null;
    };

const SHELL_STYLE = `
:root{color-scheme:light dark;--paper:#F5F3EE;--card:#FFFFFF;--ink:#171815;--muted:#5C5E56;--border:#DDD9CF;--accent:#96531F;--accent-fg:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--paper:#121311;--card:#1A1C19;--ink:#ECEAE3;--muted:#A2A599;--border:#2B2E29;--accent:#E2A674;--accent-fg:#1D1309}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--paper);color:var(--ink);font-family:${FONT};-webkit-font-smoothing:antialiased}
main{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:2rem}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9375rem}
.brand svg{width:1.5rem;height:1.5rem}
h1{margin:1.5rem 0 .5rem;font-size:1.5rem;line-height:1.25;font-weight:600;letter-spacing:-0.01em}
p{margin:0;color:var(--muted);font-size:.9375rem;line-height:1.55}
dl{margin:1.25rem 0 0;font-size:.875rem;color:var(--muted)}
dd{margin:.125rem 0 0;color:var(--ink);font-size:.9375rem}
button{margin-top:1.5rem;width:100%;min-height:2.75rem;border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:500;font-size:.9375rem;cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.note{margin-top:.75rem;font-size:.8125rem}
`;

export const confirmPage = (input: ConfirmState): string => {
  const copy = COPY[input.locale];
  const direction = input.locale === "ar" ? "rtl" : "ltr";
  const body =
    input.state === "ask"
      ? `<h1>${copy.askTitle}</h1>
${
  input.device !== null || input.place !== null
    ? `<dl><dt>${copy.from}</dt><dd><bdi>${escapeHtml([input.device, input.place].filter(Boolean).join(" · "))}</bdi></dd></dl>`
    : ""
}
<form method="post" action="/auth/confirm">
<input type="hidden" name="r" value="${escapeHtml(input.requestId)}">
<input type="hidden" name="t" value="${escapeHtml(input.token)}">
<button type="submit">${copy.confirm}</button>
</form>
<p class="note">${copy.askNote}</p>`
      : input.state === "done"
        ? `<h1>${copy.doneTitle}</h1><p>${copy.doneBody}</p>`
        : input.state === "open"
          ? // The link's two values are after the `#`, where only this page can read them. They are
            // taken out of the address bar and history, and posted in a form body. A link without
            // them is shown as expired.
            `<div id="opening"><h1>${copy.openTitle}</h1><p>${copy.openBody}</p></div>
<div id="expired" hidden><h1>${copy.expiredTitle}</h1><p>${copy.expiredBody}</p></div>
<form id="open" method="post" action="/auth/confirm" hidden>
<input type="hidden" name="r"><input type="hidden" name="t"><input type="hidden" name="step" value="show"></form>
<script>(function () {
  var values = new URLSearchParams(location.hash.slice(1));
  var form = document.getElementById("open");
  history.replaceState(null, "", location.pathname);
  if (!values.get("r") || !values.get("t")) {
    document.getElementById("opening").hidden = true;
    document.getElementById("expired").hidden = false;
    return;
  }
  form.elements.r.value = values.get("r");
  form.elements.t.value = values.get("t");
  form.submit();
})();</script>`
          : input.state === "moving"
            ? `<h1>${copy.movingTitle}</h1><p>${copy.movingBody}</p>`
            : `<h1>${copy.expiredTitle}</h1><p>${copy.expiredBody}</p>`;
  return `<!doctype html>
<html lang="${input.locale}" dir="${direction}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>DoeDesk</title><link rel="icon" href="/favicon.svg"><style>${SHELL_STYLE}</style></head>
<body><main><div class="brand">${MARK_SVG}<span>DoeDesk</span></div>${body}</main></body></html>`;
};
