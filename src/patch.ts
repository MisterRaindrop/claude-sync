import matter from 'gray-matter';
import type { TargetType, PatchOperation, ContentType } from './types.js';

export function patchFile(
  fileContent: string,
  targetType: TargetType,
  target: string,
  operation: PatchOperation,
  content: string,
  contentType?: ContentType,
  targetDelimiter?: string,
  trimTargetWhitespace?: boolean
): string {
  switch (targetType) {
    case 'frontmatter':
      return patchFrontmatter(fileContent, target, operation, content, contentType);
    case 'heading':
      return patchHeading(fileContent, target, operation, content, targetDelimiter ?? '::', trimTargetWhitespace ?? false);
    case 'block':
      return patchBlock(fileContent, target, operation, content);
  }
}

function patchFrontmatter(
  fileContent: string,
  target: string,
  operation: PatchOperation,
  content: string,
  contentType?: ContentType
): string {
  const parsed = matter(fileContent);
  const fm = parsed.data as Record<string, unknown>;

  let value: unknown;
  if (contentType === 'application/json') {
    value = JSON.parse(content);
  } else {
    value = content;
  }

  switch (operation) {
    case 'replace':
      fm[target] = value;
      break;
    case 'append':
      if (Array.isArray(fm[target])) {
        if (Array.isArray(value)) {
          fm[target] = [...(fm[target] as unknown[]), ...value];
        } else {
          (fm[target] as unknown[]).push(value);
        }
      } else if (typeof fm[target] === 'string') {
        fm[target] = (fm[target] as string) + String(value);
      } else {
        fm[target] = value;
      }
      break;
    case 'prepend':
      if (Array.isArray(fm[target])) {
        if (Array.isArray(value)) {
          fm[target] = [...(value as unknown[]), ...(fm[target] as unknown[])];
        } else {
          (fm[target] as unknown[]).unshift(value);
        }
      } else if (typeof fm[target] === 'string') {
        fm[target] = String(value) + (fm[target] as string);
      } else {
        fm[target] = value;
      }
      break;
  }

  return matter.stringify(parsed.content, fm);
}

interface HeadingInfo {
  level: number;
  text: string;
  lineIndex: number;
}

function parseHeadings(lines: string[]): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        lineIndex: i,
      });
    }
  }
  return headings;
}

function findHeadingSection(
  lines: string[],
  headingPath: string[],
  trimWhitespace: boolean
): { headingLineIndex: number; sectionStart: number; sectionEnd: number } {
  const allHeadings = parseHeadings(lines);
  let searchScope = { start: 0, end: lines.length };
  let headingLineIndex = -1;

  for (let pathIdx = 0; pathIdx < headingPath.length; pathIdx++) {
    const targetText = trimWhitespace ? headingPath[pathIdx].trim() : headingPath[pathIdx];
    let found = false;

    for (const h of allHeadings) {
      if (h.lineIndex < searchScope.start || h.lineIndex >= searchScope.end) continue;

      const hText = trimWhitespace ? h.text.trim() : h.text;
      if (hText === targetText) {
        headingLineIndex = h.lineIndex;

        // Find the end of this heading's section (next heading of same or higher level)
        let sectionEnd = searchScope.end;
        for (const h2 of allHeadings) {
          if (h2.lineIndex > h.lineIndex && h2.lineIndex < searchScope.end && h2.level <= h.level) {
            sectionEnd = h2.lineIndex;
            break;
          }
        }

        searchScope = { start: h.lineIndex + 1, end: sectionEnd };
        found = true;
        break;
      }
    }

    if (!found) {
      return { headingLineIndex: -1, sectionStart: -1, sectionEnd: -1 };
    }
  }

  return {
    headingLineIndex,
    sectionStart: searchScope.start,
    sectionEnd: searchScope.end,
  };
}

function patchHeading(
  fileContent: string,
  target: string,
  operation: PatchOperation,
  content: string,
  delimiter: string,
  trimWhitespace: boolean
): string {
  const headingPath = delimiter ? target.split(delimiter) : [target];
  const lines = fileContent.split('\n');
  const { headingLineIndex, sectionStart, sectionEnd } = findHeadingSection(lines, headingPath, trimWhitespace);

  if (headingLineIndex === -1) {
    throw new Error(`heading not found: ${target}`);
  }

  const before = lines.slice(0, sectionStart);
  const sectionContent = lines.slice(sectionStart, sectionEnd);
  const after = lines.slice(sectionEnd);

  let newSection: string[];
  switch (operation) {
    case 'replace':
      newSection = content.split('\n');
      break;
    case 'append':
      newSection = [...sectionContent, ...content.split('\n')];
      break;
    case 'prepend':
      newSection = [...content.split('\n'), ...sectionContent];
      break;
  }

  return [...before, ...newSection, ...after].join('\n');
}

function patchBlock(
  fileContent: string,
  target: string,
  operation: PatchOperation,
  content: string
): string {
  const blockRef = target.startsWith('^') ? target : `^${target}`;
  const lines = fileContent.split('\n');

  const lineIdx = lines.findIndex(l => l.trimEnd().endsWith(blockRef));
  if (lineIdx === -1) {
    throw new Error(`block reference not found: ${target}`);
  }

  // Find paragraph boundaries (blank lines)
  let paraStart = lineIdx;
  while (paraStart > 0 && lines[paraStart - 1].trim() !== '') {
    paraStart--;
  }
  let paraEnd = lineIdx;
  while (paraEnd < lines.length - 1 && lines[paraEnd + 1].trim() !== '') {
    paraEnd++;
  }

  const before = lines.slice(0, paraStart);
  const paragraph = lines.slice(paraStart, paraEnd + 1);
  const after = lines.slice(paraEnd + 1);

  let newParagraph: string[];
  switch (operation) {
    case 'replace':
      newParagraph = content.split('\n');
      break;
    case 'append':
      newParagraph = [...paragraph, ...content.split('\n')];
      break;
    case 'prepend':
      newParagraph = [...content.split('\n'), ...paragraph];
      break;
  }

  return [...before, ...newParagraph, ...after].join('\n');
}
