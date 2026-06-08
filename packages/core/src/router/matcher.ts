import type { MatchInputs, RouteDecision, RoutingConfig } from './types.js';

/**
 * Decide what to do with a Feishu inbound text.
 *
 * Precedence (per design §8 + reframe §3.2):
 *
 *   1. Override prefixes (`!cc`, `!cc:repo`, `!cc:repo@host`, `!ec2`,
 *      `!plain`) — always win.
 *   2. Destructive-verb pre-routing refusal: if the text mentions a
 *      destructive verb AND no active worker exists for the resolved
 *      cwd, reject without queuing (§7 row 3).
 *   3. Exact project name match — anchors the message to that project
 *      (and its cwd via worker_aliases).
 *   4. Path / file-extension / repo-verb / toolchain / explicit-verb
 *      tokens — dispatch to mac.
 *   5. ec2_self_solve tokens (only when embedded LLM is enabled).
 *   6. ec2_direct_answer tokens (only when embedded LLM is enabled).
 *   7. Fallback: ec2_self_solve when LLM enabled, else reject_no_worker.
 *
 * The matcher is pure: it returns a decision; the caller wires it to
 * the doorbell + Feishu reply.
 */

export interface MatchOverride {
  /** Stripped of the prefix; the remainder is what should reach the worker. */
  text: string;
  decision: RouteDecision;
}

/**
 * Parse the leading override prefix off a message body. Returns the
 * decision shape + the residual text the worker (or fallback path)
 * should see. Returns `null` if no prefix present.
 */
export function parseOverridePrefix(raw: string, cfg: RoutingConfig): MatchOverride | null {
  const text = raw.trimStart();
  // !plain — direct-answer with no tools (used when LLM enabled).
  if (text.startsWith('!plain ')) {
    return {
      text: text.slice('!plain '.length).trim(),
      decision: { kind: 'ec2_direct_answer', reason: 'override:!plain' },
    };
  }
  // !ec2 — postline-side answer with builtin tools.
  if (text.startsWith('!ec2 ')) {
    return {
      text: text.slice('!ec2 '.length).trim(),
      decision: { kind: 'ec2_self_solve', reason: 'override:!ec2' },
    };
  }
  // !cc:repo@host — pin host.
  const cmHostMatch = /^!cc:([^\s@]+)@(\S+)\s+(.*)$/s.exec(text);
  if (cmHostMatch) {
    const repo = cmHostMatch[1];
    const host = cmHostMatch[2];
    const rest = cmHostMatch[3] ?? '';
    if (repo && host) {
      const cwd = cfg.workerAliases.get(repo);
      const decision: RouteDecision = {
        kind: 'dispatch_to_mac',
        host,
        reason: `override:!cc:${repo}@${host}`,
        ...(cwd !== undefined ? { cwd } : {}),
      };
      return { text: rest.trim(), decision };
    }
  }
  // !cc:repo — repo-routed dispatch.
  const cmRepoMatch = /^!cc:(\S+)\s+(.*)$/s.exec(text);
  if (cmRepoMatch) {
    const repo = cmRepoMatch[1];
    const rest = cmRepoMatch[2] ?? '';
    if (repo) {
      const cwd = cfg.workerAliases.get(repo);
      const decision: RouteDecision = {
        kind: 'dispatch_to_mac',
        reason: `override:!cc:${repo}`,
        ...(cwd !== undefined ? { cwd } : {}),
      };
      return { text: rest.trim(), decision };
    }
  }
  // !cc — default mac dispatch (no specific cwd).
  if (text.startsWith('!cc ')) {
    return {
      text: text.slice('!cc '.length).trim(),
      decision: { kind: 'dispatch_to_mac', reason: 'override:!cc' },
    };
  }
  return null;
}

/**
 * Decide a route for an inbound text. The override path runs first
 * (and short-circuits the rest). Otherwise we walk the precedence
 * tiers from §8.
 *
 * Returns the decision plus the (possibly trimmed) text that should
 * become the worker's prompt or postline's reply context.
 */
export function matchRoute(
  cfg: RoutingConfig,
  inputs: MatchInputs,
): { text: string; decision: RouteDecision } {
  const override = parseOverridePrefix(inputs.text, cfg);
  if (override) {
    return checkDestructiveOverride(override, cfg, inputs);
  }

  const lower = inputs.text.toLowerCase();

  // Tier 2 — destructive verbs without override route to refusal when
  // no resolvable worker is available. We resolve the cwd from the
  // first project anchor we can find in the text; if none, no cwd
  // hint, and the predicate sees an empty cwd which always returns
  // false.
  const verbHit = cfg.destructiveVerbs.find((v) => lower.includes(v.toLowerCase()));
  if (verbHit) {
    const projectHit = cfg.projects.find((p) => lower.includes(p.toLowerCase()));
    const cwd = projectHit ? (cfg.workerAliases.get(projectHit) ?? '') : '';
    const hasWorker = cwd ? inputs.hasActiveWorkerForCwd(cwd) : false;
    if (!hasWorker) {
      return {
        text: inputs.text,
        decision: {
          kind: 'reject_destructive_no_worker',
          verbHit,
          reason: `destructive:${verbHit}`,
        },
      };
    }
    // Worker exists for the matched cwd; fall through to dispatch.
    return {
      text: inputs.text,
      decision: {
        kind: 'dispatch_to_mac',
        reason: `destructive:${verbHit}+worker`,
        ...(cwd ? { cwd } : {}),
      },
    };
  }

  // Tier 3 — exact project name match.
  const projectHit = cfg.projects.find((p) => lower.includes(p.toLowerCase()));
  if (projectHit) {
    const cwd = cfg.workerAliases.get(projectHit);
    return {
      text: inputs.text,
      decision: {
        kind: 'dispatch_to_mac',
        reason: `project:${projectHit}`,
        ...(cwd !== undefined ? { cwd } : {}),
      },
    };
  }

  // Tier 4 — path / repo-verb / toolchain / explicit-verb tokens.
  const macToken = cfg.dispatchToMacTokens.find((t) => lower.includes(t.toLowerCase()));
  if (macToken) {
    return {
      text: inputs.text,
      decision: {
        kind: 'dispatch_to_mac',
        reason: `token:${macToken}`,
      },
    };
  }

  // Tier 5 / 6 / 7 only fire when LLM is enabled. With LLM off, the
  // bridge has no way to actually answer — fall straight through to
  // the no-worker reject.
  if (inputs.embeddedLlmEnabled) {
    const selfTok = cfg.ec2SelfSolveTokens.find((t) => lower.includes(t.toLowerCase()));
    if (selfTok) {
      return {
        text: inputs.text,
        decision: { kind: 'ec2_self_solve', reason: `self:${selfTok}` },
      };
    }
    const directTok = cfg.ec2DirectAnswerTokens.find((t) => lower.includes(t.toLowerCase()));
    if (directTok) {
      return {
        text: inputs.text,
        decision: { kind: 'ec2_direct_answer', reason: `direct:${directTok}` },
      };
    }
    // Fallback for LLM-on: ec2_self_solve.
    return {
      text: inputs.text,
      decision: { kind: 'ec2_self_solve', reason: 'fallback:llm_on' },
    };
  }

  // LLM-off fallback: tell the user no worker for this request.
  return {
    text: inputs.text,
    decision: { kind: 'reject_no_worker', reason: 'fallback:no_llm' },
  };
}

/**
 * Override paths still need the destructive-verb safety check before
 * we hand them to a queue; if the user types `!cc:postline deploy now`
 * but no worker is up, queueing it is unsafe.
 */
function checkDestructiveOverride(
  override: MatchOverride,
  cfg: RoutingConfig,
  inputs: MatchInputs,
): { text: string; decision: RouteDecision } {
  const d = override.decision;
  if (d.kind !== 'dispatch_to_mac') return { text: override.text, decision: d };

  const lowered = override.text.toLowerCase();
  const verbHit = cfg.destructiveVerbs.find((v) => lowered.includes(v.toLowerCase()));
  if (!verbHit) return { text: override.text, decision: d };

  // Resolve the cwd: explicit override > project anchor inside the text.
  const cwd = d.cwd ?? '';
  const hasWorker = cwd ? inputs.hasActiveWorkerForCwd(cwd) : false;
  if (!hasWorker) {
    return {
      text: override.text,
      decision: {
        kind: 'reject_destructive_no_worker',
        verbHit,
        reason: `destructive:${verbHit}+override`,
      },
    };
  }
  return { text: override.text, decision: d };
}
