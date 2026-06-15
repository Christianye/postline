import { describe, expect, it } from 'vitest';
import { parseRoutingMarkdown } from './parser.js';

describe('parseRoutingMarkdown', () => {
  it('parses the canonical example body verbatim', () => {
    const body = `
# Postline Routing Rules

> Some preamble.

## projects (highest non-override precedence)
- postline   (postline doc-only edits → ec2_self_solve)
- NeuGate
- openclaw
- claude-memory

## dispatch_to_mac (path / toolchain / verbs)
- path token: ~/, /Users/, ./, *.ts, *.py
- repo verbs: repo, branch, commit, "PR #", merge
- toolchain: pnpm, npm, vitest

## ec2_self_solve  (postline uses builtin tools to answer)
- web_fetch: 查 docs, 搜, http(s)://...
- github remote queries

## ec2_direct_answer  (model + memory only)
- chitchat / greetings

## destructive_verbs (refuse-when-no-worker, per §7 row 3)
- deploy, "rm -rf", "force push", "drop table", "git push --force"

## cwd_aliases (which workers serve which keywords)
postline      → /users/dev/Downloads/ClaudeCode/postline
NeuGate       → /users/dev/Downloads/ClaudeCode/NeuGate
`;
    const cfg = parseRoutingMarkdown(body);

    expect(cfg.projects).toEqual(['postline', 'NeuGate', 'openclaw', 'claude-memory']);

    expect(cfg.dispatchToMacTokens).toContain('~/');
    expect(cfg.dispatchToMacTokens).toContain('/Users/');
    expect(cfg.dispatchToMacTokens).toContain('*.ts');
    expect(cfg.dispatchToMacTokens).toContain('repo');
    expect(cfg.dispatchToMacTokens).toContain('PR #');
    expect(cfg.dispatchToMacTokens).toContain('pnpm');

    expect(cfg.ec2SelfSolveTokens).toContain('查 docs');
    expect(cfg.ec2SelfSolveTokens).toContain('http(s)://...');
    expect(cfg.ec2SelfSolveTokens).toContain('github remote queries');

    expect(cfg.ec2DirectAnswerTokens).toContain('chitchat / greetings');

    expect(cfg.destructiveVerbs).toContain('deploy');
    expect(cfg.destructiveVerbs).toContain('rm -rf');
    expect(cfg.destructiveVerbs).toContain('force push');
    expect(cfg.destructiveVerbs).toContain('git push --force');

    expect(cfg.workerAliases.get('postline')).toBe('/users/dev/Downloads/ClaudeCode/postline');
    expect(cfg.workerAliases.get('NeuGate')).toBe('/users/dev/Downloads/ClaudeCode/NeuGate');
  });

  it('returns empty lists for an empty file', () => {
    const cfg = parseRoutingMarkdown('');
    expect(cfg.projects).toEqual([]);
    expect(cfg.dispatchToMacTokens).toEqual([]);
    expect(cfg.workerAliases.size).toBe(0);
  });

  it('accepts `## worker_aliases` (canonical name, reframe/README)', () => {
    const cfg = parseRoutingMarkdown('## worker_aliases\npostline -> /repo/postline\n');
    expect(cfg.workerAliases.get('postline')).toBe('/repo/postline');
  });

  it('still accepts `## cwd_aliases` (back-compat alias)', () => {
    const cfg = parseRoutingMarkdown('## cwd_aliases\npostline -> /repo/postline\n');
    expect(cfg.workerAliases.get('postline')).toBe('/repo/postline');
  });

  it('ignores unknown sections and prose between headers', () => {
    const cfg = parseRoutingMarkdown(`
## something_else
- ignore me

Some prose without a heading.

## projects
- foo
- bar
`);
    expect(cfg.projects).toEqual(['foo', 'bar']);
  });

  it('strips backticks around bullet entries', () => {
    const cfg = parseRoutingMarkdown(`
## dispatch_to_mac
- \`pnpm\`
- \`vitest\`
`);
    expect(cfg.dispatchToMacTokens).toEqual(['pnpm', 'vitest']);
  });

  it('handles asterisk bullets, not just dash', () => {
    const cfg = parseRoutingMarkdown(`
## projects
* alpha
* beta
`);
    expect(cfg.projects).toEqual(['alpha', 'beta']);
  });

  it('drops malformed cwd_aliases entries silently (tolerant)', () => {
    const cfg = parseRoutingMarkdown(`
## cwd_aliases
- this is not a mapping
- valid-name → /tmp/valid
- another = /tmp/also-ok
`);
    expect(cfg.workerAliases.get('valid-name')).toBe('/tmp/valid');
    expect(cfg.workerAliases.get('another')).toBe('/tmp/also-ok');
    expect(cfg.workerAliases.size).toBe(2);
  });

  it('preserves quoted phrases as a single token even with commas', () => {
    const cfg = parseRoutingMarkdown(`
## destructive_verbs
- "rm -rf", deploy, "force push"
`);
    expect(cfg.destructiveVerbs).toEqual(['rm -rf', 'deploy', 'force push']);
  });

  it('treats single-token bullets without commas as one item (no split)', () => {
    const cfg = parseRoutingMarkdown(`
## ec2_direct_answer
- chitchat / greetings
- short factual lookups
`);
    expect(cfg.ec2DirectAnswerTokens).toEqual(['chitchat / greetings', 'short factual lookups']);
  });

  describe('## wake', () => {
    it('defaults to pl when no ## wake section', () => {
      expect(parseRoutingMarkdown('## projects\n- postline\n').wake).toBe('pl');
    });

    it('reads a custom wake-name (bare line)', () => {
      expect(parseRoutingMarkdown('## wake\ncc\n').wake).toBe('cc');
    });

    it('reads a custom wake-name (bullet form)', () => {
      expect(parseRoutingMarkdown('## wake\n- bot\n').wake).toBe('bot');
    });

    it('lowercases the wake-name', () => {
      expect(parseRoutingMarkdown('## wake\nPL2\n').wake).toBe('pl2');
    });

    it('falls back to default for a reserved word (ec2 / plain)', () => {
      expect(parseRoutingMarkdown('## wake\nec2\n').wake).toBe('pl');
      expect(parseRoutingMarkdown('## wake\nplain\n').wake).toBe('pl');
    });

    it('falls back to default for an invalid shape', () => {
      expect(parseRoutingMarkdown('## wake\n!!!\n').wake).toBe('pl');
    });

    it('first valid line wins; later lines ignored', () => {
      expect(parseRoutingMarkdown('## wake\nfoo\nbar\n').wake).toBe('foo');
    });
  });
});
