/**
 * Tiny YAML frontmatter parser — we only need key: value pairs at the top
 * level. Claude Code skills don't use nested structures, lists, or anchors,
 * so this is safer and faster than pulling in js-yaml.
 *
 * Returns { frontmatter, body }. Missing / malformed frontmatter yields an
 * empty object + the original content as body.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string | boolean>;
  body: string;
} {
  // Must start with `---` on its own line and close with another `---`.
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: raw };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) {
    // unclosed frontmatter — treat whole doc as body
    return { frontmatter: {}, body: raw };
  }
  const frontmatter: Record<string, string | boolean> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === 'true') frontmatter[key] = true;
    else if (value === 'false') frontmatter[key] = false;
    else frontmatter[key] = value;
  }
  const body = lines
    .slice(closeIdx + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return { frontmatter, body };
}
