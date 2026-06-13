import DOMPurify from 'dompurify';
import type { UpdateInfo } from '../../lib/update-contracts';

const SAFE_RELEASE_NOTE_TAGS = [
  'p',
  'strong',
  'em',
  'b',
  'i',
  'code',
  'ul',
  'ol',
  'li',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function releaseNotesLooksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

export function releaseNotesMarkdownToHtml(markdown: string): string {
  const html: string[] = [];
  let openList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (openList) {
      html.push(`</${openList}>`);
      openList = null;
    }
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      if (openList !== 'ul') {
        closeList();
        openList = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      if (openList !== 'ol') {
        closeList();
        openList = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeList();
  return html.join('');
}

export function getReleaseNotesHtml(
  releaseNotes?: UpdateInfo['releaseNotes']
): string {
  if (!releaseNotes) {
    return '';
  }

  let html: string;

  if (typeof releaseNotes === 'string') {
    const trimmed = releaseNotes.trim();
    html = releaseNotesLooksLikeHtml(trimmed)
      ? trimmed
      : releaseNotesMarkdownToHtml(trimmed);
  } else if (Array.isArray(releaseNotes)) {
    html = releaseNotes
      .map((note) => {
        const version = escapeHtml(note.version);
        const body = note.note ? renderInlineMarkdown(note.note) : '';
        return `<p><strong>${version}</strong>: ${body}</p>`;
      })
      .join('');
  } else {
    return '';
  }

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SAFE_RELEASE_NOTE_TAGS,
    ALLOWED_ATTR: [],
  });
}
