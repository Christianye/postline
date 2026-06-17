/**
 * Router types — what the parser produces and the matcher consumes.
 *
 * Source of truth for the file format: design `docs/designs/doorbell.md`
 * §8 + reframe §3.2. The parser is forgiving: unknown sections become
 * empty rule lists; malformed entries log a warning and are skipped.
 */

export type RouteKind =
  | 'dispatch_to_mac'
  | 'ec2_self_solve'
  | 'ec2_direct_answer'
  | 'reject_no_worker'
  | 'reject_destructive_no_worker';

/**
 * Result of router.match(). The decision is final; the caller (Feishu
 * dispatcher) maps it to either a doorbell enqueue or a direct reply.
 */
export type RouteDecision =
  | {
      kind: 'dispatch_to_mac';
      /** Optional cwd to target (resolved via worker_aliases or override). */
      cwd?: string;
      /**
       * Optional worker selector from the 3-segment prefix
       * `!<wake>@<selector>@<repo>`. Matched against a worker's `host`
       * OR `agentKind` (cc / codex / …) at dispatch time. Undefined for
       * the 1- and 2-segment forms.
       */
      selector?: string;
      /** Free-form trace token for log lines / responder display. */
      reason: string;
    }
  | {
      kind: 'ec2_self_solve';
      reason: string;
    }
  | {
      kind: 'ec2_direct_answer';
      reason: string;
    }
  | {
      /** Default no-LLM fallback: tell user to start a worker. */
      kind: 'reject_no_worker';
      /** Hint about which cwd the user might have meant. */
      hintCwd?: string;
      reason: string;
    }
  | {
      /** Tasks containing destructive verbs cannot enter the lossy queue. */
      kind: 'reject_destructive_no_worker';
      verbHit: string;
      reason: string;
    };

/**
 * Parsed routing.md. Each section is the rule list under that h2 in the
 * markdown file. Order within a list is preserved (it matters for
 * "earliest-matching keyword wins").
 */
export interface RoutingConfig {
  /**
   * Wake-name for override prefixes. Configured via `## wake` in
   * routing.md; defaults to `pl`. Prefixes are built dynamically:
   * `!<wake>`, `!<wake>@<repo>`, `!<wake>@<selector>@<repo>`,
   * `!<wake> ec2`, `!<wake> plain`.
   */
  wake: string;
  /** Project name → cwd map. e.g. `postline → /home/dev/.../postline`. */
  workerAliases: ReadonlyMap<string, string>;
  /** Project names recognised as anchors (highest non-override precedence). */
  projects: readonly string[];
  /** Path / file-extension / repo-verb / toolchain / explicit-verb triggers. */
  dispatchToMacTokens: readonly string[];
  /** Triggers for the LLM-mode-only ec2_self_solve path. */
  ec2SelfSolveTokens: readonly string[];
  /** Triggers for the LLM-mode-only ec2_direct_answer path. */
  ec2DirectAnswerTokens: readonly string[];
  /** Verbs that mark a task too dangerous to queue without a live worker. */
  destructiveVerbs: readonly string[];
}

/**
 * Inputs the matcher needs to decide a route. The Feishu dispatcher
 * fills these in from the inbound message + the doorbell coordinator's
 * current worker registry view.
 */
export interface MatchInputs {
  /** User-supplied text after `@cc` is stripped. */
  text: string;
  /** Whether postline has an embedded LLM available. */
  embeddedLlmEnabled: boolean;
  /**
   * Predicate the matcher calls to ask "is there an active worker for
   * this cwd right now?". Used to decide whether destructive verbs
   * should reject (no worker) or proceed (have one).
   */
  hasActiveWorkerForCwd: (cwd: string) => boolean;
}
