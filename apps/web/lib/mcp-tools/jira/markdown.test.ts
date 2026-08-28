import { adfToMarkdown } from './adf';
import { isBlankMarkdown, markdownToAdf } from './markdown';

/** The node types in document order, for asserting block structure. */
const blockTypes = (markdown: string): string[] =>
  markdownToAdf(markdown).content.map((node) => node.type);

/** First paragraph's inline nodes, as `[text, marks]` pairs. */
const inlineOf = (markdown: string) => {
  const [first] = markdownToAdf(markdown).content;
  return (first?.content ?? []).map((node) => [
    node.text,
    (node.marks ?? []).map((mark) => mark.type),
  ]);
};

describe('markdownToAdf', () => {
  it('always produces a valid empty document for empty input', () => {
    expect(markdownToAdf('')).toEqual({ version: 1, type: 'doc', content: [] });
  });

  it('joins a soft-wrapped paragraph into one block', () => {
    expect(inlineOf('one\ntwo')).toEqual([['one two', []]]);
  });

  it('splits paragraphs on a blank line', () => {
    expect(blockTypes('First.\n\nSecond.')).toEqual(['paragraph', 'paragraph']);
  });

  it('reads headings, rules, quotes, fences and lists as blocks', () => {
    expect(blockTypes('# Title')).toEqual(['heading']);
    expect(blockTypes('---')).toEqual(['rule']);
    expect(blockTypes('> quoted')).toEqual(['blockquote']);
    expect(blockTypes('```\ncode\n```')).toEqual(['codeBlock']);
    expect(blockTypes('- one\n- two')).toEqual(['bulletList']);
    expect(blockTypes('1. one')).toEqual(['orderedList']);
  });

  it('ends a paragraph where the next block begins, without a blank line', () => {
    expect(blockTypes('intro text\n- one\n- two')).toEqual(['paragraph', 'bulletList']);
  });

  it('records the heading level', () => {
    const [heading] = markdownToAdf('#### Deep').content;
    expect(heading?.attrs).toEqual({ level: 4 });
  });

  it('carries the code fence language, and does not interpret the body', () => {
    const [block] = markdownToAdf('```sql\nselect * from t; -- **not bold**\n```').content;
    expect(block?.attrs).toEqual({ language: 'sql' });
    expect(block?.content?.[0]?.text).toBe('select * from t; -- **not bold**');
  });

  it('restores an escape inside a fence to the bare character', () => {
    // Masking happens before blocks are split, so a backslash-escape inside a
    // fence yields the character it escaped rather than both. Only the escapable
    // set is affected — `C:\path` survives intact, as the test above shows.
    const [block] = markdownToAdf('```\nselect \\* from t;\n```').content;
    expect(block?.content?.[0]?.text).toBe('select * from t;');
  });

  it('runs an unterminated fence to the end of input', () => {
    const [block] = markdownToAdf('```\nstill code\nand more').content;
    expect(block?.type).toBe('codeBlock');
    expect(block?.content?.[0]?.text).toBe('still code\nand more');
  });

  it('emits no content for an empty code block rather than an empty text node', () => {
    const [block] = markdownToAdf('```\n```').content;
    expect(block).toEqual({ type: 'codeBlock' });
  });

  describe('inline marks', () => {
    it('reads bold, italic, strike and code', () => {
      expect(inlineOf('**b**')).toEqual([['b', ['strong']]]);
      expect(inlineOf('__b__')).toEqual([['b', ['strong']]]);
      expect(inlineOf('*i*')).toEqual([['i', ['em']]]);
      expect(inlineOf('_i_')).toEqual([['i', ['em']]]);
      expect(inlineOf('~~s~~')).toEqual([['s', ['strike']]]);
      expect(inlineOf('`c`')).toEqual([['c', ['code']]]);
    });

    it('stacks marks rather than nesting nodes', () => {
      expect(inlineOf('***both***')).toEqual([['both', ['strong', 'em']]]);
    });

    it('closes on the last delimiter of a run', () => {
      // The bug the negative lookahead exists for: without it this captures
      // "bold *and italic" and leaves a stray asterisk behind.
      expect(inlineOf('**bold *and italic***')).toEqual([
        ['bold ', ['strong']],
        ['and italic', ['strong', 'em']],
      ]);
    });

    it('does not read underscores inside a word as emphasis', () => {
      expect(inlineOf('snake_case_name')).toEqual([['snake_case_name', []]]);
    });

    it('treats delimiters inside a code span as literal', () => {
      expect(inlineOf('`a *b* c`')).toEqual([['a *b* c', ['code']]]);
    });

    it('links, keeping the href out of the text', () => {
      const [[value, marks]] = inlineOf('see [the RFC](https://x.test/a_b)');
      expect(value).toBe('see ');
      expect(marks).toEqual([]);
      const [, link] = inlineOf('see [the RFC](https://x.test/a_b)');
      expect(link).toEqual(['the RFC', ['link']]);
      const [, second] =
        markdownToAdf('see [the RFC](https://x.test/a_b)').content[0]?.content ?? [];
      expect(second?.marks?.[0]?.attrs).toEqual({ href: 'https://x.test/a_b' });
    });
  });

  describe('escapes', () => {
    it('takes an escaped delimiter literally', () => {
      expect(inlineOf('\\*not italic\\*')).toEqual([['*not italic*', []]]);
    });

    it('keeps a backslash that escapes nothing escapable', () => {
      expect(inlineOf('C:\\path')).toEqual([['C:\\path', []]]);
    });

    it('survives recursion into a blockquote', () => {
      // Restoring is positional, not sequential: an earlier implementation
      // desynchronised here and restored the wrong characters.
      const [quote] = markdownToAdf('> \\*one\\* and \\_two\\_').content;
      expect(quote?.content?.[0]?.content?.[0]?.text).toBe('*one* and _two_');
    });
  });

  describe('lists', () => {
    it('nests by relative indent, whatever the step', () => {
      const twoSpace = markdownToAdf('- outer\n  - inner');
      const fourSpace = markdownToAdf('- outer\n    - inner');
      const inner = (doc: ReturnType<typeof markdownToAdf>) =>
        doc.content[0]?.content?.[0]?.content?.[1];

      expect(inner(twoSpace)?.type).toBe('bulletList');
      expect(inner(fourSpace)?.type).toBe('bulletList');
    });

    it('keeps each item a paragraph inside a listItem', () => {
      const [list] = markdownToAdf('- one\n- two').content;
      expect(list?.content).toHaveLength(2);
      expect(list?.content?.[0]?.type).toBe('listItem');
      expect(list?.content?.[0]?.content?.[0]?.type).toBe('paragraph');
    });

    it('accepts both ) and . as ordered markers', () => {
      expect(blockTypes('1) one')).toEqual(['orderedList']);
    });

    it('collapses an empty wrapper item into its nested list', () => {
      // A model faking a section label. Rendered literally this is an empty
      // numbered row with "Request" demoted a level — Jira shows "1." over
      // "a. Request".
      const [list] = markdownToAdf('1. \n   1. Request').content;
      expect(list?.type).toBe('orderedList');
      expect(list?.content).toHaveLength(1);
      expect(list?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('Request');
    });

    it('lets a lone wrapper item hand the list over to its nested kind', () => {
      const [list] = markdownToAdf('1. \n   - a\n   - b').content;
      expect(list?.type).toBe('bulletList');
      expect(list?.content).toHaveLength(2);
    });

    it('hoists a wrapper item among real siblings into the same level', () => {
      const [list] = markdownToAdf('1. first\n2. \n   1. hoisted\n3. third').content;
      expect(list?.type).toBe('orderedList');
      expect(list?.content).toHaveLength(3);
      expect(list?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe('hoisted');
    });

    it('keeps an item with text AND a nested list nested, as written', () => {
      const [list] = markdownToAdf('1. outer\n   1. inner').content;
      expect(list?.content).toHaveLength(1);
      expect(list?.content?.[0]?.content?.[1]?.type).toBe('orderedList');
    });

    it('keeps the starting number of an ordered list that starts past 1', () => {
      const [list] = markdownToAdf('3. third\n4. fourth').content;
      expect(list?.attrs).toEqual({ order: 3 });
    });

    it('adds no order attribute when the list starts at 1', () => {
      const [list] = markdownToAdf('1. one\n2. two').content;
      expect(list?.attrs).toBeUndefined();
    });
  });

  describe('round trip', () => {
    it.each([
      'Plain prose.',
      'A **bold** claim and an *aside*.',
      '# Heading\n\nBody text.',
      '- one\n- two',
      '- outer\n  - inner',
      '1. first\n2. second',
      '2. resumed\n3. onward',
      '> quoted line',
      '```sql\nselect 1;\n```',
      'A [link](https://x.test) inline.',
      '---',
    ])('survives %j', (source) => {
      expect(adfToMarkdown(markdownToAdf(source))).toBe(source);
    });

    it('normalises a soft-wrapped paragraph to one line', () => {
      expect(adfToMarkdown(markdownToAdf('one\ntwo'))).toBe('one two');
    });
  });
});

describe('isBlankMarkdown', () => {
  it('is true for nothing but whitespace', () => {
    expect(isBlankMarkdown('')).toBe(true);
    expect(isBlankMarkdown('   \n\t')).toBe(true);
  });

  it('is false once there is content', () => {
    expect(isBlankMarkdown('x')).toBe(false);
  });
});
