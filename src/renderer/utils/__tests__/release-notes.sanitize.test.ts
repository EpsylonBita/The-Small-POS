import { describe, expect, it } from 'vitest';
import { getReleaseNotesHtml } from '../release-notes';

// Release notes reach the update dialog from the published latest.json and
// are rendered as HTML. DOMPurify keeps only the release-note tag list and no
// attributes at all. This pins that contract across DOMPurify upgrades
// (3.4.12 -> 3.4.17 for GHSA-cg2g-xh64-v4q7 / GHSA-mrv2-3pqr-j5jr).

const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'b', 'i', 'code', 'ul', 'ol', 'li', 'br', 'h1', 'h2', 'h3', 'h4']);

function tagsIn(html: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll('*'), (element) => element.tagName.toLowerCase());
}

function attributesIn(html: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll('*')).flatMap((element) =>
    Array.from(element.attributes, (attribute) => attribute.name),
  );
}

describe('getReleaseNotesHtml sanitization', () => {
  it('keeps the allowed release-note tags and their text', () => {
    const html = getReleaseNotesHtml(
      '<h2>1.4.137</h2><p><strong>Bold</strong> <em>em</em> <b>b</b> <i>i</i> <code>x</code><br></p><ul><li>one</li></ul><ol><li>two</li></ol>',
    );

    expect(html).toContain('<h2>1.4.137</h2>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('<ul><li>one</li></ul>');
    expect(html).toContain('<ol><li>two</li></ol>');
    expect(tagsIn(html).every((tag) => ALLOWED_TAGS.has(tag))).toBe(true);
  });

  it('strips script, style, iframe, svg and other disallowed elements', () => {
    const html = getReleaseNotesHtml(
      [
        '<p>Safe text</p>',
        '<script>window.__pwned = 1</script>',
        '<style>body{display:none}</style>',
        '<iframe src="https://evil.example"></iframe>',
        '<svg><script>alert(1)</script></svg>',
        '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
        '<img src=x onerror="alert(1)">',
        '<a href="javascript:alert(1)">link text</a>',
        '<form action="https://evil.example"><input name="pin"></form>',
        '<template><script>alert(1)</script></template>',
      ].join(''),
    );

    expect(html).toContain('<p>Safe text</p>');
    expect(html).toContain('link text');
    expect(html).not.toMatch(/<\s*(script|style|iframe|svg|math|img|a|form|input|template)\b/i);
    expect(html).not.toMatch(/javascript:|window\.__pwned|alert\(/i);
    expect(tagsIn(html).every((tag) => ALLOWED_TAGS.has(tag))).toBe(true);
  });

  it('removes every attribute, event handlers included, even on allowed tags', () => {
    const html = getReleaseNotesHtml(
      '<p onclick="alert(1)" style="color:red" class="x" id="y" data-x="1" aria-label="unsafe">Hello</p>'
      + '<strong onmouseover="alert(2)" title="t">World</strong>'
      + '<li onfocus="alert(3)" tabindex="0" autofocus>Item</li>',
    );

    expect(attributesIn(html)).toEqual([]);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).toContain('Hello');
    expect(html).toContain('World');
  });

  it('escapes markdown that carries raw HTML-looking payloads in the version list form', () => {
    const html = getReleaseNotesHtml([
      { version: '<img src=x onerror=alert(1)>', note: '<script>alert(1)</script> **bold**' },
    ]);

    expect(tagsIn(html).every((tag) => ALLOWED_TAGS.has(tag))).toBe(true);
    expect(attributesIn(html)).toEqual([]);
    expect(html).not.toMatch(/<\s*(img|script)\b/i);
    expect(html).toContain('<strong>bold</strong>');
  });

  it('defeats mutation-XSS style nesting', () => {
    const html = getReleaseNotesHtml(
      '<p><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript></p>'
      + '<p><svg><p><style><img src=x onerror=alert(2)></style></p></svg></p>',
    );

    expect(tagsIn(html).every((tag) => ALLOWED_TAGS.has(tag))).toBe(true);
    expect(attributesIn(html)).toEqual([]);
    expect(html).not.toMatch(/<\s*(img|svg|style|noscript)\b/i);
  });
});
