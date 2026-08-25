import { markdownToAdf } from './markdown';

describe('Markdown mentions', () => {
  it('converts [~accountId] patterns to ADF mention nodes', () => {
    const markdown = 'Hey [~557058:3bce8cf9-3a60-4a2e-b655-1af9f0dfc93f], check this out';
    const doc = markdownToAdf(markdown);

    const mentionNode = findNodeOfType(doc.content, 'mention');
    expect(mentionNode).toBeDefined();
    if (mentionNode && mentionNode.type === 'mention' && mentionNode.attrs) {
      const attrs = mentionNode.attrs;
      if (typeof attrs.id === 'string') {
        expect(attrs.id).toBe('557058:3bce8cf9-3a60-4a2e-b655-1af9f0dfc93f');
      }
    }
  });

  it('preserves non-mention text with marks', () => {
    const markdown = 'Hey [~557058:3bce8cf9-3a60-4a2e-b655-1af9f0dfc93f], **this is bold**';
    const doc = markdownToAdf(markdown);

    const mentionNode = findNodeOfType(doc.content, 'mention');
    const boldNode = findNodeWithMark(doc.content, 'strong');

    expect(mentionNode).toBeDefined();
    expect(boldNode).toBeDefined();
  });

  it("converts Jira Cloud's documented [~accountid:ID] syntax", () => {
    // The exact text a real jira_add_comment call posted, which came out as
    // literal characters: no chip, nobody notified.
    const doc = markdownToAdf(
      '[~accountid:5b21a397a6d3c211bbc5f967] testing mention via jira_add_comment.'
    );
    const mention = findNodeOfType(doc.content, 'mention');
    expect(mention).toBeDefined();
    expect(mention?.attrs?.id).toBe('5b21a397a6d3c211bbc5f967');
  });

  it('converts a bare 24-hex account id', () => {
    const doc = markdownToAdf('Hey [~5b21a397a6d3c211bbc5f967], take a look');
    const mention = findNodeOfType(doc.content, 'mention');
    expect(mention?.attrs?.id).toBe('5b21a397a6d3c211bbc5f967');
  });

  it('accepts the accountid: prefix on the colon form too', () => {
    const doc = markdownToAdf('[~accountid:557058:3bce8cf9-3a60-4a2e-b655-1af9f0dfc93f] hi');
    const mention = findNodeOfType(doc.content, 'mention');
    expect(mention?.attrs?.id).toBe('557058:3bce8cf9-3a60-4a2e-b655-1af9f0dfc93f');
  });

  it('keeps the surrounding words when the mention leads the sentence', () => {
    const doc = markdownToAdf('[~5b21a397a6d3c211bbc5f967] please review before Friday.');
    const text = collectText(doc.content);
    expect(text).toContain('please review before Friday.');
    // ...and the id must not also survive as literal characters.
    expect(text).not.toContain('5b21a397a6d3c211bbc5f967');
  });

  it('leaves text around an unresolvable bracket intact', () => {
    // The skipped match must not swallow the words after it.
    const doc = markdownToAdf('Ask [~username] about [~5b21a397a6d3c211bbc5f967] later');
    const text = collectText(doc.content);
    expect(text).toContain('Ask [~username] about');
    expect(text).toContain('later');
    expect(findNodeOfType(doc.content, 'mention')?.attrs?.id).toBe('5b21a397a6d3c211bbc5f967');
  });

  it('falls back to literal [~text] when not a valid accountId', () => {
    const markdown = 'Hey [~username], this is plain text';
    const doc = markdownToAdf(markdown);

    const mentionNode = findNodeOfType(doc.content, 'mention');
    expect(mentionNode).toBeUndefined();
  });
});

interface AdfNode {
  type: string;
  text?: string;
  marks?: Array<{ type: string }>;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

function findNodeOfType(nodes: AdfNode[], type: string): AdfNode | undefined {
  for (const node of nodes) {
    if (node.type === type) return node;
    if (node.content) {
      const found = findNodeOfType(node.content, type);
      if (found) return found;
    }
  }
  return undefined;
}

function collectText(nodes: AdfNode[]): string {
  return nodes
    .map(
      (node) =>
        (node.type === 'text' ? (node.text ?? '') : '') +
        (node.content ? collectText(node.content) : '')
    )
    .join('');
}

function findNodeWithMark(nodes: AdfNode[], markType: string): AdfNode | undefined {
  for (const node of nodes) {
    if (node.marks && node.marks.some((m) => m.type === markType)) return node;
    if (node.content) {
      const found = findNodeWithMark(node.content, markType);
      if (found) return found;
    }
  }
  return undefined;
}
