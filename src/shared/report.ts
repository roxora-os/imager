// "Report a problem", from Maskrom Studio's src/shared/report.ts: a link to
// a new roxora-os/imager issue with its title and body filled in, which the
// user's browser opens and the user reads, edits and sends (or not), and
// the whole log saved to a file to attach. Nothing is sent by the app. What
// goes into either is scrubbed first: the home folder and the user name,
// e-mail and IP addresses, USB serial numbers, the app's file tokens and
// anything that looks like a key or password. No Electron here, so the
// tests use it.

export const ISSUES_NEW = 'https://github.com/roxora-os/imager/issues/new';
/** GitHub refuses longer links; the body is cut to fit, the full log goes in the saved file. */
export const MAX_URL = 8000;

export interface Who {
  /** The home folder as the OS has it (/home/ann, /Users/ann, C:\Users\ann); '' when not known (the web build). */
  home: string;
  user: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scrub(text: string, who: Who): string {
  let out = text;
  if (who.home && who.home.length > 1) {
    // As written, and with the other slash (logs mix them on Windows).
    for (const h of new Set([who.home, who.home.replace(/\\/g, '/'), who.home.replace(/\//g, '\\')])) {
      out = out.replace(new RegExp(escape(h), 'gi'), '~');
    }
  }
  out = out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    // An IPv4 address, not a four-part version number ("version 10.0.22631.2428", "v1.0.0.135").
    .replace(/(?<![\w.])(?<!version |v)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/gi, '<ip>')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>')
    .replace(/(serial(?:\s*number)?["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<serial>')
    .replace(/(app:\/\/local\/file\/)[A-Za-z0-9_-]+/g, '$1<token>')
    .replace(/((?:token|password|passwd|secret|key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<removed>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<removed>');
  if (who.user && who.user.length >= 3 && !/^(root|user|admin|test)$/i.test(who.user)) {
    out = out.replace(new RegExp(`\\b${escape(who.user)}\\b`, 'gi'), '<user>');
  }
  return out;
}

/** What the page knows about a failed write. Every field is shown in the issue before it is sent. */
export interface ReportFacts {
  version: string;
  commit: string;
  os: string;
  arch: string;
  board: string | null;
  /** The release image, by its file name in the release; null for a file on this computer. */
  image: string | null;
  /** Where it was written: "SD card or USB drive", "eMMC over Maskrom", "an image file". */
  destination: string | null;
  /** The step that failed, as the run page named it. */
  step: string | null;
  error: string | null;
  detail?: string | null;
  log: string[];
}

function body(f: ReportFacts, logLines: string[], who: Who): string {
  const s = (x: string | null | undefined) => scrub(x ?? '', who);
  return [
    '## What happened',
    '',
    '<!-- What you did and what you expected. -->',
    '',
    '## Details',
    '',
    `- Roxora Imager ${f.version} (${f.commit})`,
    `- ${[f.os, f.arch].filter(Boolean).join(', ')}`,
    `- Board: ${f.board ?? '(none chosen)'}`,
    ...(f.image ? [`- Image: ${s(f.image)}`] : []),
    ...(f.destination ? [`- Destination: ${s(f.destination)}`] : []),
    ...(f.step ? [`- Step that failed: ${s(f.step)}`] : []),
    ...(f.error ? [`- Error: ${s(f.error)}`] : []),
    ...(f.detail ? ['', '```', s(f.detail), '```'] : []),
    ...(f.log.length ? [
      '',
      `## Log (${logLines.length === f.log.length ? 'all' : `last ${logLines.length}`} lines)`,
      '',
      ...(logLines.length < f.log.length ? ['Please attach the full log, saved with "Save full log", to this issue.', ''] : []),
      '```',
      ...logLines.map(s),
      '```',
    ] : []),
    '',
  ].join('\n');
}

/** The link to a new issue, its log cut from the front until it fits MAX_URL. */
export function issueUrl(f: ReportFacts, who: Who): string {
  const title = `${f.error ? scrub(f.error, who).slice(0, 90) : 'Problem'} (${f.board ?? 'no board'}, ${f.os})`;
  for (let n = Math.min(50, f.log.length); ; n = n > 10 ? n - 10 : n - 1) {
    const lines = n > 0 ? f.log.slice(-n) : [];
    const url = `${ISSUES_NEW}?${new URLSearchParams({ title, body: body(f, lines, who) }).toString()}`;
    if (url.length <= MAX_URL || n <= 0) return url.length <= MAX_URL ? url : `${ISSUES_NEW}?${new URLSearchParams({ title }).toString()}`;
  }
}

/** The whole log for the file to attach, with the same facts on top. */
export function fullLog(f: ReportFacts, who: Who): string {
  return body(f, f.log, who);
}

/** Facts from the page, as plain strings: anything else is left out. */
export function factsFrom(x: unknown, base: Pick<ReportFacts, 'version' | 'commit' | 'os' | 'arch'>): ReportFacts {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : null);
  return {
    ...base,
    board: str(o.board), image: str(o.image), destination: str(o.destination),
    step: str(o.step), error: str(o.error), detail: str(o.detail),
    log: Array.isArray(o.log) ? o.log.map(String).slice(-5000) : [],
  };
}
