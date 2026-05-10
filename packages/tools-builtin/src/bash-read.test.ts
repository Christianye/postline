import { describe, expect, it } from 'vitest';
import { __classifyReadOnlyForTest as classify } from './bash.js';

describe('bash_read classifier', () => {
  const OK: string[] = [
    'whoami',
    'ls -la /tmp',
    'hostname',
    'cat /etc/hostname',
    'ps aux | head -5',
    'ps aux | grep node',
    'df -h && free -h',
    'git log --oneline -5',
    'git status',
    'git diff HEAD~1',
    'git -C /home/ubuntu/postline log -1',
    'systemctl is-active cc.service',
    'systemctl status cc.service --no-pager',
    'journalctl -u cc --since "5 min ago" --no-pager',
    'docker ps',
    'echo hi > /dev/null',
    'find /tmp -name "*.log" | head -5',
    'FOO=bar whoami',
    // M5.6: dev tool --version / --help
    'node --version',
    'node -v',
    'python3 --version',
    'python --version',
    'pnpm --version',
    'pnpm list',
    'pnpm ls',
    'npm view react',
    'npm show react',
    'pip show requests',
    'claude --version',
    'claude --help',
    'go version',
    'cargo --version',
    // combined version-check 场景（real-world self-check use case）
    'node --version; grep -E "name|version" package.json | head -5',
    'claude --version 2>&1 | head -5; echo "---"; systemctl is-active cc.service',
    // M5.6.1 (EC2 CC report 2026-05-10): `2>&1;` was regexed greedily into redirect target
    'systemctl is-active cc.service 2>&1; systemctl status cc.service --no-pager',
    'node --version 2>&1; pnpm --version 2>&1',
  ];
  const BAD: Array<[string, RegExp]> = [
    ['rm -rf /tmp/x', /not in the read-only allowlist/],
    ['touch /tmp/x', /not in the read-only allowlist/],
    ['curl https://example.com', /web_fetch/],
    ['git push origin main', /git sub-command/],
    ['git commit -m "x"', /git sub-command/],
    ['git pull', /git sub-command/],
    ['sudo ls /root', /sudo is not allowed/],
    ['systemctl restart cc.service', /systemctl sub-command/],
    ['docker run -it alpine', /docker sub-command/],
    ['echo hi > /tmp/out.txt', /output redirection/],
    ['cat log >> /tmp/log', /append redirection/],
    ['eval "ls"', /eval is not allowed/],
    // M5.6: write verbs on multimodal tools MUST be rejected
    ['npm install', /write verb.*install/],
    ['npm install react', /write verb.*install/],
    ['pnpm add lodash', /write verb.*add/],
    ['pip install requests', /write verb.*install/],
    ['cargo publish', /write verb.*publish/],
    ['node script.js', /not recognized as read-only/],
    ['python3 run.py', /not recognized as read-only/],
    ['node', /no arguments.*REPL/],
    ['python3', /no arguments.*REPL/],
    // M5.6: unknown dev tool subs still rejected
    ['pnpm dlx something', /not recognized as read-only/],
  ];

  for (const cmd of OK) {
    it(`allows: ${cmd}`, () => {
      expect(classify(cmd)).toBeNull();
    });
  }
  for (const [cmd, re] of BAD) {
    it(`rejects: ${cmd}`, () => {
      const reason = classify(cmd);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(re);
    });
  }
});
