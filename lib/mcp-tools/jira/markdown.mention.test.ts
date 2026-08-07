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

  it('falls back to literal [~text] when not a valid accountId', () => {
    const markdown = 'Hey [~username], this is plain text';
    const doc = markdownToAdf(markdown);

    const mentionNode = findNodeOfType(doc.content, 'mention');
    expect(mentionNode).toBeUndefined();
  });
});

interface AdfNode {
  type: string;
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
