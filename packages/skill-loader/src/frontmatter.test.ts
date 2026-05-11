import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from './frontmatter.js';

describe('splitFrontmatter', () => {
  it('parses basic key: value frontmatter', () => {
    const raw = `---
name: commit-smart
description: Smart commits
---
# body`;
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({ name: 'commit-smart', description: 'Smart commits' });
    expect(body).toBe('# body');
  });

  it('coerces true/false to booleans', () => {
    const raw = `---
disable-model-invocation: true
some-flag: false
---`;
    const { frontmatter } = splitFrontmatter(raw);
    expect(frontmatter['disable-model-invocation']).toBe(true);
    expect(frontmatter['some-flag']).toBe(false);
  });

  it('strips surrounding quotes', () => {
    const raw = `---
name: "commit-smart"
desc: 'hello world'
---`;
    const { frontmatter } = splitFrontmatter(raw);
    expect(frontmatter.name).toBe('commit-smart');
    expect(frontmatter.desc).toBe('hello world');
  });

  it('treats missing opening --- as body-only', () => {
    const raw = '# body without frontmatter\n\ntext';
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('treats unclosed frontmatter as body-only', () => {
    const raw = '---\nname: test\n# no closer\n\nmore';
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('ignores comment lines and blank lines in frontmatter', () => {
    const raw = `---
# this is a comment

name: foo
---
body`;
    const { frontmatter } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({ name: 'foo' });
  });

  it('strips leading blank lines from body', () => {
    const raw = `---
name: foo
---


# header`;
    const { body } = splitFrontmatter(raw);
    expect(body).toBe('# header');
  });
});
