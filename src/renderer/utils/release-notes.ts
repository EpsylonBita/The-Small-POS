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

/**
 * The fixed heading that opens each language's block inside a
 * docs/CHANGELOG.md version section (`### <heading>`). The update dialog
 * shows the till only the block in its own language; the changelog test
 * checks every shipped section against this same map. Change a heading here
 * and in docs/CHANGELOG.md together.
 */
export const RELEASE_NOTES_LANGUAGE_HEADINGS = {
  el: 'Τι νέο υπάρχει σε αυτή την ενημέρωση',
  en: "What's new in this update",
  de: 'Was ist neu in diesem Update',
  fr: 'Nouveautés de cette mise à jour',
  it: 'Novità di questo aggiornamento',
  sq: 'Çfarë ka të re në këtë përditësim',
} as const;

export type ReleaseNotesLanguage = keyof typeof RELEASE_NOTES_LANGUAGE_HEADINGS;

/** Shown when the till's own language has no block: English, then Greek. */
const RELEASE_NOTES_FALLBACK_LANGUAGES: readonly ReleaseNotesLanguage[] = ['en', 'el'];

function normalizeReleaseNotesHeading(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
}

const RELEASE_NOTES_LANGUAGE_BY_HEADING = new Map<string, ReleaseNotesLanguage>(
  (Object.entries(RELEASE_NOTES_LANGUAGE_HEADINGS) as [ReleaseNotesLanguage, string][]).map(
    ([language, heading]) => [normalizeReleaseNotesHeading(heading), language],
  ),
);

function toReleaseNotesLanguage(language?: string | null): ReleaseNotesLanguage | null {
  const primary = String(language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return Object.prototype.hasOwnProperty.call(RELEASE_NOTES_LANGUAGE_HEADINGS, primary)
    ? (primary as ReleaseNotesLanguage)
    : null;
}

interface ReleaseNotesLanguageBlock {
  language: ReleaseNotesLanguage;
  start: number;
  end: number;
}

/**
 * Finds the `### <language heading>` blocks of one changelog section. A block
 * runs to the next language heading, or to the next `#`/`##` heading (another
 * section), or to the end of the text.
 */
function findReleaseNotesLanguageBlocks(notes: string): ReleaseNotesLanguageBlock[] {
  const headings: Array<{ language: ReleaseNotesLanguage; start: number }> = [];
  const languageHeading = /^###[ \t]+(.+?)[ \t]*$/gm;
  for (let match = languageHeading.exec(notes); match; match = languageHeading.exec(notes)) {
    const language = RELEASE_NOTES_LANGUAGE_BY_HEADING.get(normalizeReleaseNotesHeading(match[1]));
    if (language) {
      headings.push({ language, start: match.index });
    }
  }

  const sectionStarts: number[] = [];
  const sectionHeading = /^#{1,2}[ \t]+\S/gm;
  for (let match = sectionHeading.exec(notes); match; match = sectionHeading.exec(notes)) {
    sectionStarts.push(match.index);
  }

  return headings.map((heading, index) => {
    const nextLanguageStart = headings[index + 1]?.start ?? notes.length;
    const nextSectionStart = sectionStarts.find((start) => start > heading.start) ?? notes.length;
    return {
      language: heading.language,
      start: heading.start,
      end: Math.min(nextLanguageStart, nextSectionStart),
    };
  });
}

/**
 * Keeps only the block written in the till's language from a changelog
 * section that carries one block per language, falling back to English, then
 * Greek. Text with fewer than two language blocks (sections written before
 * the multilingual format, the workflow's "Release vX" fallback) comes back
 * unchanged. Whatever precedes the first block (the `## X.Y.Z` heading) is
 * kept.
 */
export function selectReleaseNotesForLanguage(
  notes: string,
  language?: string | null,
): string {
  const blocks = findReleaseNotesLanguageBlocks(notes);
  if (blocks.length < 2) {
    return notes;
  }

  const requested = toReleaseNotesLanguage(language);
  const candidates = [
    ...(requested ? [requested] : []),
    ...RELEASE_NOTES_FALLBACK_LANGUAGES,
  ];

  for (const candidate of candidates) {
    const block = blocks.find((item) => item.language === candidate);
    if (block) {
      const preamble = notes.slice(0, blocks[0].start);
      return `${preamble}${notes.slice(block.start, block.end)}`.trimEnd();
    }
  }

  return notes;
}

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

/**
 * `language` is the till's current i18n language: a multilingual changelog
 * section shows only that language's block (see selectReleaseNotesForLanguage).
 */
export function getReleaseNotesHtml(
  releaseNotes?: UpdateInfo['releaseNotes'],
  language?: string | null,
): string {
  if (!releaseNotes) {
    return '';
  }

  let html: string;

  if (typeof releaseNotes === 'string') {
    const trimmed = selectReleaseNotesForLanguage(releaseNotes.trim(), language);
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
