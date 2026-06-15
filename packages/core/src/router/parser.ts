import type { RoutingConfig } from './types.js';

/**
 * Parse a routing.md body into a RoutingConfig.
 *
 * The format is the markdown laid out in `docs/designs/doorbell.md` §8:
 * h2 sections delimit rule categories; bullets inside a section are
 * the trigger tokens.
 *
 * Sections recognised (h2 case-insensitive, whitespace tolerant):
 *
 *   ## wake                          → wake-name for override prefixes (default `pl`)
 *   ## projects                      → projects (list of anchor names)
 *   ## dispatch_to_mac (...)         → dispatchToMacTokens
 *   ## ec2_self_solve (...)          → ec2SelfSolveTokens
 *   ## ec2_direct_answer (...)       → ec2DirectAnswerTokens
 *   ## destructive_verbs (...)       → destructiveVerbs
 *   ## worker_aliases (...)          → workerAliases (key → cwd value)
 *                                       (alias: `## cwd_aliases`, back-compat)
 *
 * Anything in front matter or under `## something_else` is ignored.
 * Lines that aren't list items inside a recognised section are
 * dropped — they're typically prose / notes for the human reader.
 *
 * Tolerant by design: a single malformed line in routing.md must not
 * stop the parser from honouring the rest of the file.
 */

const KNOWN_SECTIONS = new Set([
  'wake',
  'projects',
  'dispatch_to_mac',
  'ec2_self_solve',
  'ec2_direct_answer',
  'destructive_verbs',
  'cwd_aliases',
]);

/** Default wake-name when routing.md has no `## wake` section. */
export const DEFAULT_WAKE = 'pl';

/**
 * Words that can't be used as a wake-name because they collide with the
 * mode sub-keywords (`!<wake> ec2`, `!<wake> plain`) or would create
 * ambiguous prefixes. Setting `## wake` to any of these falls back to
 * the default.
 */
const RESERVED_WAKE = new Set(['ec2', 'plain']);

/** Valid wake-name shape: one lowercase token, `[a-z0-9-]+`. */
const WAKE_RE = /^[a-z0-9-]+$/;

interface MutableConfig {
  wake: string;
  workerAliases: Map<string, string>;
  projects: string[];
  dispatchToMacTokens: string[];
  ec2SelfSolveTokens: string[];
  ec2DirectAnswerTokens: string[];
  destructiveVerbs: string[];
}

export function parseRoutingMarkdown(body: string): RoutingConfig {
  const cfg: MutableConfig = {
    wake: DEFAULT_WAKE,
    workerAliases: new Map(),
    projects: [],
    dispatchToMacTokens: [],
    ec2SelfSolveTokens: [],
    ec2DirectAnswerTokens: [],
    destructiveVerbs: [],
  };

  let currentSection: string | null = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const heading = matchH2(line);
    if (heading !== null) {
      // `worker_aliases` is the canonical name (reframe §3.2 + README + docs);
      // `cwd_aliases` is the original name kept as a back-compat alias. Both
      // map to the same internal handling.
      const canonical = heading === 'worker_aliases' ? 'cwd_aliases' : heading;
      currentSection = KNOWN_SECTIONS.has(canonical) ? canonical : null;
      continue;
    }
    if (currentSection === null) continue;

    // wake: a single token, given as a bare line or a bullet. First
    // valid non-reserved token wins; later lines ignored.
    if (currentSection === 'wake') {
      const direct = line.trim();
      if (!direct || direct.startsWith('#') || direct.startsWith('>')) continue;
      const item = matchListItem(line) ?? direct;
      feedSection(cfg, currentSection, item);
      continue;
    }

    // cwd_aliases is special: design §8 shows it as direct lines
    // (`name → /path`) rather than bullets. Accept both styles.
    if (currentSection === 'cwd_aliases') {
      const direct = line.trim();
      if (!direct || direct.startsWith('#') || direct.startsWith('>')) continue;
      const item = matchListItem(line) ?? direct;
      feedSection(cfg, currentSection, item);
      continue;
    }

    const item = matchListItem(line);
    if (!item) continue;
    feedSection(cfg, currentSection, item);
  }

  return {
    wake: cfg.wake,
    workerAliases: cfg.workerAliases,
    projects: cfg.projects,
    dispatchToMacTokens: cfg.dispatchToMacTokens,
    ec2SelfSolveTokens: cfg.ec2SelfSolveTokens,
    ec2DirectAnswerTokens: cfg.ec2DirectAnswerTokens,
    destructiveVerbs: cfg.destructiveVerbs,
  };
}

/**
 * Match an h2 line. Returns the lowered slug or null if not a heading.
 * Strips trailing parenthetical commentary like `(highest precedence)`.
 */
function matchH2(line: string): string | null {
  const m = /^##\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  const headerRaw = m[1] ?? '';
  // Drop everything after the first `(`.
  const slug = headerRaw.split('(')[0]?.trim().toLowerCase() ?? '';
  return slug;
}

/** Match a markdown list item (`-` or `*`). Returns the body text or null. */
function matchListItem(line: string): string | null {
  const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  return m[1] ?? null;
}

function feedSection(cfg: MutableConfig, section: string, item: string): void {
  // Strip inline-code wrappers: `verb` → verb. Preserves visual hint
  // for humans without forcing matchers to deal with backticks.
  const stripped = stripBackticks(item);

  if (section === 'wake') {
    // Take the first token only; ignore trailing commentary.
    const raw = stripped.split(/\s+/)[0]?.trim().toLowerCase() ?? '';
    // Only override the default once, and only for a valid, non-reserved
    // name. Invalid / reserved / duplicate lines leave the default in place.
    if (cfg.wake === DEFAULT_WAKE && raw && raw !== DEFAULT_WAKE) {
      if (WAKE_RE.test(raw) && !RESERVED_WAKE.has(raw)) {
        cfg.wake = raw;
      }
    }
    return;
  }
  if (section === 'projects') {
    // Ignore parenthetical commentary on a project line, e.g.
    //   - postline   (postline doc-only edits → ec2_self_solve)
    const name = stripped.split(/\s+/)[0]?.trim();
    if (name) cfg.projects.push(name);
    return;
  }
  if (section === 'cwd_aliases') {
    // Format: `name → /path` or `name -> /path` or `name = /path`.
    const m = /^(\S+)\s*(?:→|->|=)\s*(.+)$/.exec(stripped);
    if (m?.[1] && m?.[2]) {
      cfg.workerAliases.set(m[1], m[2].trim());
    }
    return;
  }
  // For trigger sections, strip leading bullet sub-prefixes like
  // `path token: ~/, ./, *.ts` — we accept both styles by keeping the
  // raw item as one token and ALSO splitting on common separators
  // when a colon is present. This is forgiving: parsers downstream
  // do `text.includes(token)` so a redundant token is harmless.
  const tokens = extractTokens(stripped);
  if (section === 'dispatch_to_mac') cfg.dispatchToMacTokens.push(...tokens);
  else if (section === 'ec2_self_solve') cfg.ec2SelfSolveTokens.push(...tokens);
  else if (section === 'ec2_direct_answer') cfg.ec2DirectAnswerTokens.push(...tokens);
  else if (section === 'destructive_verbs') cfg.destructiveVerbs.push(...tokens);
}

function stripBackticks(s: string): string {
  return s.replace(/`/g, '');
}

/**
 * Pull tokens out of a list-item body. If the body has the form
 * `category: tok1, tok2, "phrase three"`, split on the comma. Otherwise
 * the whole body is one token. Quoted phrases are preserved verbatim.
 */
function extractTokens(body: string): string[] {
  const colonIdx = body.indexOf(':');
  const payload = colonIdx >= 0 ? body.slice(colonIdx + 1).trim() : body.trim();
  if (!payload) return [];
  // If no comma, it's a single token (could be a quoted phrase).
  if (!payload.includes(',')) {
    return [unquote(payload)];
  }
  // Split on commas, but respect quoted regions.
  const out: string[] = [];
  let buf = '';
  let inQuote: '"' | "'" | null = null;
  for (const ch of payload) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ',') {
      const t = buf.trim();
      if (t) out.push(unquote(t));
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(unquote(tail));
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
