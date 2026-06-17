import { describe, expect, it } from 'vitest';
import { matchRoute, parseOverridePrefix } from './matcher.js';
import { parseRoutingMarkdown } from './parser.js';
import type { MatchInputs, RoutingConfig } from './types.js';

const FIXTURE_BODY = `
## projects
- postline
- acme-api
- acme-web

## dispatch_to_mac
- path token: ~/, /Users/, ./, *.ts, *.py
- repo verbs: repo, branch, commit, "PR #"
- toolchain: pnpm, vitest, claude code
- explicit verbs: 看代码, 改代码, review, debug

## ec2_self_solve
- web_fetch: 查 docs
- memory queries: 我之前说过

## ec2_direct_answer
- chitchat / greetings
- 你好, 早

## destructive_verbs
- deploy, "rm -rf", "force push", drop

## cwd_aliases
- postline → /home/dev/postline
- acme-api → /home/dev/acme-api
`;

const cfg: RoutingConfig = parseRoutingMarkdown(FIXTURE_BODY);

function inputs(over: Partial<MatchInputs> = {}): MatchInputs {
  return {
    text: '',
    embeddedLlmEnabled: false,
    hasActiveWorkerForCwd: () => true,
    ...over,
  };
}

describe('parseOverridePrefix', () => {
  it('!pl (1-seg) → dispatch_to_mac with no cwd', () => {
    const r = parseOverridePrefix('!pl do this thing', cfg);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
    expect(r?.text).toBe('do this thing');
    if (r?.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.cwd).toBeUndefined();
      expect(r.decision.selector).toBeUndefined();
    }
  });

  it('!pl@postline (2-seg) → dispatch_to_mac resolves cwd via aliases', () => {
    const r = parseOverridePrefix('!pl@postline review the diff', cfg);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
    expect(r?.text).toBe('review the diff');
    if (r?.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.cwd).toBe('/home/dev/postline');
      expect(r.decision.selector).toBeUndefined();
    }
  });

  it('!pl@cc@postline (3-seg) → selector + cwd via aliases', () => {
    const r = parseOverridePrefix('!pl@cc@postline run lint', cfg);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
    expect(r?.text).toBe('run lint');
    if (r?.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.selector).toBe('cc');
      expect(r.decision.cwd).toBe('/home/dev/postline');
    }
  });

  it('!pl@ec2@postline (3-seg) → host selector', () => {
    const r = parseOverridePrefix('!pl@ec2@postline run lint', cfg);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
    if (r?.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.selector).toBe('ec2');
      expect(r.decision.cwd).toBe('/home/dev/postline');
    }
  });

  it('!pl@unknown_repo passes through with no cwd (alias lookup misses)', () => {
    const r = parseOverridePrefix('!pl@made-up do something', cfg);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
    if (r?.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.cwd).toBeUndefined();
    }
  });

  it('!pl ec2 → ec2_self_solve', () => {
    const r = parseOverridePrefix('!pl ec2 search docs for X', cfg);
    expect(r?.decision.kind).toBe('ec2_self_solve');
    expect(r?.text).toBe('search docs for X');
  });

  it('!pl plain → ec2_direct_answer', () => {
    const r = parseOverridePrefix('!pl plain hello', cfg);
    expect(r?.decision.kind).toBe('ec2_direct_answer');
    expect(r?.text).toBe('hello');
  });

  it('returns null when no prefix is present', () => {
    expect(parseOverridePrefix('plain message', cfg)).toBeNull();
  });

  it('does not false-match a word starting with the wake-name (!please)', () => {
    expect(parseOverridePrefix('!please help me', cfg)).toBeNull();
  });

  it('handles leading whitespace before prefix', () => {
    const r = parseOverridePrefix('   !pl test', cfg);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
  });

  it('honours a custom wake-name from ## wake', () => {
    const custom = parseRoutingMarkdown(`${FIXTURE_BODY}\n## wake\ncc\n`);
    expect(custom.wake).toBe('cc');
    const r = parseOverridePrefix('!cc@postline go', custom);
    expect(r?.decision.kind).toBe('dispatch_to_mac');
    if (r?.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.cwd).toBe('/home/dev/postline');
    }
    // default !pl no longer matches under custom wake
    expect(parseOverridePrefix('!pl@postline go', custom)).toBeNull();
  });
});

describe('matchRoute — precedence', () => {
  it('override wins over everything', () => {
    const r = matchRoute(cfg, inputs({ text: '!pl ec2 review postline 的 routing' }));
    expect(r.decision.kind).toBe('ec2_self_solve');
  });

  it('exact project anchor wins over plain explicit verb', () => {
    const r = matchRoute(cfg, inputs({ text: 'review postline 的 routing' }));
    expect(r.decision.kind).toBe('dispatch_to_mac');
    if (r.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.cwd).toBe('/home/dev/postline');
    }
  });

  it('explicit verb without project anchor still routes mac', () => {
    const r = matchRoute(cfg, inputs({ text: '改代码 in some file' }));
    expect(r.decision.kind).toBe('dispatch_to_mac');
    if (r.decision.kind === 'dispatch_to_mac') {
      expect(r.decision.cwd).toBeUndefined();
    }
  });

  it('path token (~/) routes mac', () => {
    const r = matchRoute(cfg, inputs({ text: 'check ~/.zshrc for path' }));
    expect(r.decision.kind).toBe('dispatch_to_mac');
  });

  it('repo verb routes mac', () => {
    const r = matchRoute(cfg, inputs({ text: 'check the latest commit' }));
    expect(r.decision.kind).toBe('dispatch_to_mac');
  });

  it('toolchain token routes mac', () => {
    const r = matchRoute(cfg, inputs({ text: 'run pnpm install' }));
    expect(r.decision.kind).toBe('dispatch_to_mac');
  });
});

describe('matchRoute — destructive verbs (§7 row 3)', () => {
  it('destructive + project + no worker → reject_destructive_no_worker', () => {
    const r = matchRoute(
      cfg,
      inputs({
        text: 'deploy postline now',
        hasActiveWorkerForCwd: () => false,
      }),
    );
    expect(r.decision.kind).toBe('reject_destructive_no_worker');
    if (r.decision.kind === 'reject_destructive_no_worker') {
      expect(r.decision.verbHit).toBe('deploy');
    }
  });

  it('destructive + project + worker present → dispatches to mac', () => {
    const r = matchRoute(
      cfg,
      inputs({
        text: 'deploy postline now',
        hasActiveWorkerForCwd: (cwd) => cwd === '/home/dev/postline',
      }),
    );
    expect(r.decision.kind).toBe('dispatch_to_mac');
  });

  it('destructive without project → still rejects (no resolvable cwd)', () => {
    const r = matchRoute(
      cfg,
      inputs({
        text: 'force push the branch',
        hasActiveWorkerForCwd: () => true, // would route but we don't know which cwd
      }),
    );
    expect(r.decision.kind).toBe('reject_destructive_no_worker');
  });

  it('destructive override (!pl@postline deploy) without worker still refuses', () => {
    const r = matchRoute(
      cfg,
      inputs({
        text: '!pl@postline deploy now',
        hasActiveWorkerForCwd: () => false,
      }),
    );
    expect(r.decision.kind).toBe('reject_destructive_no_worker');
  });

  it('destructive override with worker proceeds', () => {
    const r = matchRoute(
      cfg,
      inputs({
        text: '!pl@postline deploy now',
        hasActiveWorkerForCwd: (cwd) => cwd === '/home/dev/postline',
      }),
    );
    expect(r.decision.kind).toBe('dispatch_to_mac');
    expect(r.text).toBe('deploy now');
  });

  it('"rm -rf" hits destructive token (multi-word)', () => {
    const r = matchRoute(
      cfg,
      inputs({
        text: 'rm -rf in some path',
        hasActiveWorkerForCwd: () => false,
      }),
    );
    expect(r.decision.kind).toBe('reject_destructive_no_worker');
  });
});

describe('matchRoute — embedded LLM toggle (RF1)', () => {
  it('LLM-off + no-match → reject_no_worker', () => {
    const r = matchRoute(cfg, inputs({ text: 'random unrelated thing' }));
    expect(r.decision.kind).toBe('reject_no_worker');
  });

  it('LLM-on + no-match → ec2_self_solve fallback', () => {
    const r = matchRoute(cfg, inputs({ text: 'random unrelated thing', embeddedLlmEnabled: true }));
    expect(r.decision.kind).toBe('ec2_self_solve');
  });

  it('LLM-on + ec2_self_solve token → ec2_self_solve', () => {
    const r = matchRoute(cfg, inputs({ text: '查 docs about X', embeddedLlmEnabled: true }));
    expect(r.decision.kind).toBe('ec2_self_solve');
  });

  it('LLM-on + ec2_direct_answer token → ec2_direct_answer', () => {
    const r = matchRoute(cfg, inputs({ text: '你好 cc', embeddedLlmEnabled: true }));
    expect(r.decision.kind).toBe('ec2_direct_answer');
  });

  it('LLM-off + ec2_self_solve token still rejects (no LLM available)', () => {
    const r = matchRoute(cfg, inputs({ text: '查 docs about X' }));
    expect(r.decision.kind).toBe('reject_no_worker');
  });
});
