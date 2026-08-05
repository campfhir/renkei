#!/usr/bin/env node
/**
 * Fix ESLint async warnings by wrapping plain promises.
 * Focuses on common patterns: function calls, fetch, method chains.
 *
 * Run: pnpm tsx scripts/fix-async-warnings.ts
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

function findFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentPath: string) {
    try {
      const entries = readdirSync(currentPath);
      for (const entry of entries) {
        if (['node_modules', '.next', 'dist', '.claude'].includes(entry)) continue;
        const fullPath = path.join(currentPath, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx'))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip on errors
    }
  }

  walk(dir);
  return files;
}

interface TransformResult {
  file: string;
  wrapped: number;
}

/**
 * Find matching closing bracket/paren at same depth level
 */
function findMatchingBracket(str: string, openPos: number): number {
  const openChar = str[openPos];
  const closeChar = openChar === '(' ? ')' : openChar === '[' ? ']' : '}';
  let depth = 1;
  let i = openPos + 1;
  let inString = false;
  let stringChar = '';

  while (i < str.length && depth > 0) {
    const char = str[i];

    if (inString) {
      if (char === stringChar && str[i - 1] !== '\\') inString = false;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      stringChar = char;
    } else if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
    }

    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Extract expression after await, stopping at statement boundaries
 */
function getAwaitExpression(content: string, startPos: number): { expr: string; end: number } | null {
  let i = startPos;
  const length = content.length;

  // Skip whitespace
  while (i < length && /\s/.test(content[i])) i++;

  if (i >= length) return null;

  const exprStart = i;
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let hasOpenBracket = false;

  while (i < length) {
    const char = content[i];

    // Handle strings
    if (inString) {
      if (char === stringChar && content[i - 1] !== '\\') inString = false;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      stringChar = char;
      i++;
      continue;
    }

    // Handle depth
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      hasOpenBracket = true;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
    }

    // Stop at statement terminators
    if (depth === 0) {
      if (char === ';' || char === ',' || char === '\n') {
        break;
      }
    }

    i++;
  }

  const expr = content.substring(exprStart, i).trim();
  return expr.length > 0 ? { expr, end: i } : null;
}

function fixFile(filePath: string): TransformResult {
  try {
    let content = readFileSync(filePath, 'utf-8');
    const originalContent = content;
    let wrapped = 0;

    // Skip if already has wrapAsync
    if (content.includes('wrapAsync(()')) {
      return { file: filePath, wrapped: 0 };
    }

    // Process line by line to handle comments
    const lines = content.split('\n');
    const newLines: string[] = [];

    for (const line of lines) {
      const commentIdx = line.indexOf('//');
      const effectiveLine = commentIdx >= 0 ? line.substring(0, commentIdx) : line;

      // Look for await that isn't already wrapped
      if (!effectiveLine.includes('await') || effectiveLine.includes('wrapAsync(()')) {
        newLines.push(line);
        continue;
      }

      const awaitMatch = /\bawait\s+/.exec(effectiveLine);
      if (!awaitMatch) {
        newLines.push(line);
        continue;
      }

      // Build full content from this point onwards for multi-line expressions
      const pos = awaitMatch.index + awaitMatch[0].length;
      const restOfContent = line.substring(pos) + '\n' + lines.slice(newLines.length + 1).join('\n');

      const result = getAwaitExpression(restOfContent, 0);
      if (!result) {
        newLines.push(line);
        continue;
      }

      // Check if expression ends on same line
      const fullLineLength = line.length;
      const offsetInLine = pos + result.end;

      if (offsetInLine <= fullLineLength) {
        // Expression is on same line
        const before = line.substring(0, pos);
        const expr = result.expr;
        const after = line.substring(offsetInLine);
        const wrapped_line = before + `wrapAsync(() => ${expr}, 'ASYNC_ERROR' as const)` + after;
        newLines.push(wrapped_line);
        wrapped++;
      } else {
        // Multi-line expression - harder to handle reliably, skip for now
        newLines.push(line);
      }
    }

    content = newLines.join('\n');

    // Add imports if we wrapped anything
    if (wrapped > 0) {
      const importLines = content.split('\n').filter(line => line.startsWith('import '));
      const lastImportIdx = importLines.length > 0
        ? content.lastIndexOf(importLines[importLines.length - 1]) + importLines[importLines.length - 1].length
        : 0;

      if (!content.includes('wrapAsync')) {
        const insertPos = lastImportIdx > 0 ? lastImportIdx + 1 : 0;
        const insertIndex = content.indexOf('\n', insertPos);
        if (insertIndex > 0) {
          content =
            content.substring(0, insertIndex) +
            "\nimport { wrapAsync } from '@campfhir/safe-functions/helpers';" +
            content.substring(insertIndex);
        } else {
          content = "import { wrapAsync } from '@campfhir/safe-functions/helpers';\n" + content;
        }
      }
    }

    if (content !== originalContent) {
      writeFileSync(filePath, content, 'utf-8');
    }

    return { file: filePath, wrapped };
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return { file: filePath, wrapped: 0 };
  }
}

async function main() {
  const files = findFiles(process.cwd());
  console.log(`🔍 Scanning ${files.length} TypeScript files...\n`);

  let totalWrapped = 0;
  let filesModified = 0;

  for (const file of files) {
    const result = fixFile(file);
    if (result.wrapped > 0) {
      const relPath = path.relative(process.cwd(), result.file);
      console.log(`✓ ${relPath} (+${result.wrapped})`);
      filesModified++;
      totalWrapped += result.wrapped;
    }
  }

  console.log(`\n📊 Summary: ${filesModified} files modified, ${totalWrapped} promises wrapped`);
  if (totalWrapped > 0) {
    console.log(`✨ Run 'pnpm build' to verify`);
  }
}

main().catch(console.error);
