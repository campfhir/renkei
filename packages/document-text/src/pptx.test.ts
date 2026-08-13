/**
 * PowerPoint extraction: slide order and speaker notes, both of which come
 * from the relationship graph rather than filenames.
 */

import { extractText } from './index';
import { buildZip } from './test-support';

function slideXml(...lines: string[]): string {
  return (
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
    lines
      .map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join('') +
    '</p:spTree></p:cSld></p:sld>'
  );
}

const textOf = async (bytes: Uint8Array): Promise<string> => {
  const result = await extractText(bytes);
  if (!result.ok) throw new Error(`extraction failed: ${result.err.type}`);
  return result.val.text;
};

describe('pptx extraction', () => {
  it('follows presentation order, not filename order', async () => {
    // slide10 sorts before slide2 lexicographically, and creation order
    // diverges from presentation order the moment a deck is rearranged.
    const bytes = buildZip({
      'ppt/presentation.xml':
        '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>' +
        '<p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/>' +
        '</p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<?xml version="1.0"?><Relationships>' +
        '<Relationship Id="rA" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rB" Target="slides/slide2.xml"/>' +
        '</Relationships>',
      'ppt/slides/slide1.xml': slideXml('I am shown second'),
      'ppt/slides/slide2.xml': slideXml('I am shown first'),
    });

    const text = await textOf(bytes);
    expect(text.indexOf('I am shown first')).toBeLessThan(text.indexOf('I am shown second'));
  });

  it('includes speaker notes, resolved per slide', async () => {
    // Notes are frequently the only prose in a deck — slide bodies are
    // fragments — so they are the highest-value text in the file.
    const bytes = buildZip({
      'ppt/presentation.xml':
        '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>' +
        '<p:sldId id="256" r:id="rA"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="rA" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slideXml('Q4 revenue'),
      'ppt/slides/_rels/slide1.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="rN" Target="../notesSlides/notesSlide3.xml"/></Relationships>',
      // Deliberately notesSlide3 for slide1: the numbering does NOT correspond
      // when only some slides carry notes.
      'ppt/notesSlides/notesSlide3.xml': slideXml(
        'Revenue rose because the EMEA renewal closed early.'
      ),
    });

    const text = await textOf(bytes);
    expect(text).toContain('Q4 revenue');
    expect(text).toContain('Revenue rose because the EMEA renewal closed early.');
  });

  it('numbers slides in the output', async () => {
    const bytes = buildZip({
      'ppt/presentation.xml':
        '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>' +
        '<p:sldId id="256" r:id="rA"/><p:sldId id="257" r:id="rB"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<?xml version="1.0"?><Relationships>' +
        '<Relationship Id="rA" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rB" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slideXml('One'),
      'ppt/slides/slide2.xml': slideXml('Two'),
    });

    const result = await extractText(bytes);
    expect(result.ok && result.val.text).toContain('## Slide 1');
    expect(result.ok && result.val.text).toContain('## Slide 2');
    expect(result.ok && result.val.sections).toBe(2);
  });

  it('still extracts when the relationship graph is missing', async () => {
    // A malformed deck should yield text, just possibly out of order — an
    // empty result would be worse than an imperfect one.
    const bytes = buildZip({
      'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="p"/>',
      'ppt/slides/slide1.xml': slideXml('Orphaned slide'),
    });
    expect(await textOf(bytes)).toContain('Orphaned slide');
  });

  it('never emits slide-master placeholder text', async () => {
    // Masters hold "Click to edit Master title style"; extracting them would
    // have every deck in the tenant contribute the same noise.
    const bytes = buildZip({
      'ppt/presentation.xml':
        '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>' +
        '<p:sldId id="256" r:id="rA"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="rA" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slideXml('Real content'),
      'ppt/slideMasters/slideMaster1.xml': slideXml('Click to edit Master title style'),
      'ppt/slideLayouts/slideLayout1.xml': slideXml('Click to edit Master text styles'),
    });

    const text = await textOf(bytes);
    expect(text).toContain('Real content');
    expect(text).not.toContain('Master title style');
  });
});
