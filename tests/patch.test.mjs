import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchFile } from '../dist/patch.js';

// ── Frontmatter ──────────────────────────────────────────────────────

const FM_DOC = `---
title: Test note
status: active
tags: [alpha, beta]
review_after: 2026-05-01
---

# Heading A

Content A.

## Subheading A1

Content A1.

# Heading B

Content B.
`;

test('frontmatter: replace scalar field', () => {
  const result = patchFile(FM_DOC, 'frontmatter', 'status', 'replace', 'archived');
  assert.match(result, /status: archived/);
  assert.doesNotMatch(result, /status: active/);
});

test('frontmatter: replace date field', () => {
  const result = patchFile(FM_DOC, 'frontmatter', 'review_after', 'replace', '2026-10-01');
  assert.match(result, /review_after: '?2026-10-01'?/);
});

test('frontmatter: append to array field (single value)', () => {
  const result = patchFile(FM_DOC, 'frontmatter', 'tags', 'append', 'gamma');
  assert.match(result, /- alpha/);
  assert.match(result, /- beta/);
  assert.match(result, /- gamma/);
});

test('frontmatter: prepend to array field', () => {
  const result = patchFile(FM_DOC, 'frontmatter', 'tags', 'prepend', 'zero');
  // Prepended value should appear before alpha
  const zeroIdx = result.indexOf('- zero');
  const alphaIdx = result.indexOf('- alpha');
  assert.ok(zeroIdx !== -1 && alphaIdx !== -1, 'both tags present');
  assert.ok(zeroIdx < alphaIdx, 'zero is before alpha');
});

test('frontmatter: replace with JSON content', () => {
  const result = patchFile(
    FM_DOC,
    'frontmatter',
    'tags',
    'replace',
    '["new1", "new2"]',
    'application/json'
  );
  assert.match(result, /- new1/);
  assert.match(result, /- new2/);
  assert.doesNotMatch(result, /- alpha/);
});

test('frontmatter: create new field via replace', () => {
  const result = patchFile(FM_DOC, 'frontmatter', 'content_type', 'replace', 'permanent');
  assert.match(result, /content_type: permanent/);
});

// ── Heading ──────────────────────────────────────────────────────────

test('heading: append content to section', () => {
  const result = patchFile(FM_DOC, 'heading', 'Heading A', 'append', 'More content.');
  // "More content." should appear within Heading A's section (before Heading B)
  const headingAIdx = result.indexOf('# Heading A');
  const moreIdx = result.indexOf('More content.');
  const headingBIdx = result.indexOf('# Heading B');
  assert.ok(headingAIdx !== -1 && moreIdx !== -1 && headingBIdx !== -1);
  assert.ok(headingAIdx < moreIdx && moreIdx < headingBIdx);
});

test('heading: prepend content to section', () => {
  const result = patchFile(FM_DOC, 'heading', 'Heading A', 'prepend', 'Intro paragraph.');
  const headingAIdx = result.indexOf('# Heading A');
  const introIdx = result.indexOf('Intro paragraph.');
  const contentAIdx = result.indexOf('Content A.');
  assert.ok(headingAIdx < introIdx, 'intro comes after heading line');
  assert.ok(introIdx < contentAIdx, 'intro comes before existing content');
});

test('heading: replace section content', () => {
  const result = patchFile(FM_DOC, 'heading', 'Heading A', 'replace', 'Replaced body.');
  assert.match(result, /Replaced body\./);
  assert.doesNotMatch(result, /Content A\./);
  // Subheading A1 was part of the section, should also be gone
  assert.doesNotMatch(result, /Subheading A1/);
  // Heading B should still be there
  assert.match(result, /# Heading B/);
});

test('heading: nested via :: delimiter', () => {
  const result = patchFile(FM_DOC, 'heading', 'Heading A::Subheading A1', 'append', 'Nested append.');
  const sub = result.indexOf('## Subheading A1');
  const nested = result.indexOf('Nested append.');
  const headingB = result.indexOf('# Heading B');
  assert.ok(sub < nested, 'nested content after sub heading');
  assert.ok(nested < headingB, 'nested content before next top heading');
});

test('heading: missing heading throws', () => {
  assert.throws(() => {
    patchFile(FM_DOC, 'heading', 'Nonexistent', 'append', 'x');
  }, /heading not found/);
});

// ── Block ────────────────────────────────────────────────────────────

const BLOCK_DOC = `# Notes

First paragraph.
Second line of first paragraph. ^first

Another paragraph here.
More text. ^second

Third paragraph.
`;

test('block: replace paragraph', () => {
  const result = patchFile(BLOCK_DOC, 'block', 'first', 'replace', 'Replaced.');
  assert.match(result, /Replaced\./);
  assert.doesNotMatch(result, /First paragraph\./);
  // other block should be untouched
  assert.match(result, /Another paragraph/);
});

test('block: append to paragraph', () => {
  const result = patchFile(BLOCK_DOC, 'block', 'second', 'append', 'Extra line.');
  const anotherIdx = result.indexOf('Another paragraph');
  const extraIdx = result.indexOf('Extra line.');
  const thirdIdx = result.indexOf('Third paragraph');
  assert.ok(anotherIdx < extraIdx && extraIdx < thirdIdx);
});

test('block: missing block throws', () => {
  assert.throws(() => {
    patchFile(BLOCK_DOC, 'block', 'nonexistent', 'replace', 'x');
  }, /block reference not found/);
});

test('block: accepts target with or without caret prefix', () => {
  const withCaret = patchFile(BLOCK_DOC, 'block', '^first', 'replace', 'via-caret');
  const withoutCaret = patchFile(BLOCK_DOC, 'block', 'first', 'replace', 'via-plain');
  assert.match(withCaret, /via-caret/);
  assert.match(withoutCaret, /via-plain/);
});
