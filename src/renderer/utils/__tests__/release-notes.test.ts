import { describe, expect, it } from 'vitest';
import {
  RELEASE_NOTES_LANGUAGE_HEADINGS,
  type ReleaseNotesLanguage,
  getReleaseNotesHtml,
  selectReleaseNotesForLanguage,
} from '../release-notes';

// Founder rule 01/10/2026: release notes go out in every app language. A
// version section carries one block per language under a fixed heading, and
// the update dialog shows the till only the block in its own language.

const LANGUAGES = Object.keys(RELEASE_NOTES_LANGUAGE_HEADINGS) as ReleaseNotesLanguage[];

const BULLET: Record<ReleaseNotesLanguage, string> = {
  el: '- **Ελληνική σημείωση.** Κείμενο για το ταμείο.',
  en: '- **English note.** Text for the till.',
  de: '- **Deutsche Notiz.** Text für die Kasse.',
  fr: '- **Note française.** Texte pour la caisse.',
  it: '- **Nota italiana.** Testo per la cassa.',
  sq: '- **Shënim shqip.** Tekst për arkën.',
};

function block(language: ReleaseNotesLanguage): string {
  return `### ${RELEASE_NOTES_LANGUAGE_HEADINGS[language]}\n\n${BULLET[language]}`;
}

function section(languages: ReleaseNotesLanguage[]): string {
  return ['## 1.4.120', ...languages.map(block)].join('\n\n');
}

const GREEK_ONLY_SECTION = [
  '## 1.4.119',
  '',
  '### Τι νέο υπάρχει σε αυτή την ενημέρωση',
  '',
  '- **Η αναγνώριση κλήσεων γίνεται μέσα στο ταμείο.** Χωρίς να περιμένει το internet.',
  '- **Καταργήθηκε η «Ζωντανή οθόνη».** Λιγότερη κίνηση στο internet.',
].join('\n');

const WORKFLOW_FALLBACK = 'Release v1.4.120 (Tauri POS desktop).';

describe('selectReleaseNotesForLanguage', () => {
  it('gives each of the six languages its own block from a full section', () => {
    const notes = section(LANGUAGES);

    for (const language of LANGUAGES) {
      const selected = selectReleaseNotesForLanguage(notes, language);

      expect(selected).toBe(`## 1.4.120\n\n${block(language)}`);
      for (const other of LANGUAGES.filter((item) => item !== language)) {
        expect(selected).not.toContain(RELEASE_NOTES_LANGUAGE_HEADINGS[other]);
        expect(selected).not.toContain(BULLET[other]);
      }
    }
  });

  it('reads region-tagged and upper-case language codes', () => {
    const notes = section(LANGUAGES);

    expect(selectReleaseNotesForLanguage(notes, 'de-DE')).toContain(BULLET.de);
    expect(selectReleaseNotesForLanguage(notes, 'SQ')).toContain(BULLET.sq);
    expect(selectReleaseNotesForLanguage(notes, 'el_GR')).toContain(BULLET.el);
  });

  it('falls back to English when the till language has no block', () => {
    const notes = section(['el', 'en', 'fr']);

    for (const language of ['de', 'it', 'sq', 'es', '', undefined, null]) {
      const selected = selectReleaseNotesForLanguage(notes, language);
      expect(selected).toBe(`## 1.4.120\n\n${block('en')}`);
    }
  });

  it('falls back to Greek when neither the till language nor English has a block', () => {
    const notes = section(['el', 'fr']);

    expect(selectReleaseNotesForLanguage(notes, 'de')).toBe(`## 1.4.120\n\n${block('el')}`);
  });

  it('shows an old Greek-only section unchanged in every language', () => {
    for (const language of [...LANGUAGES, 'es', undefined]) {
      expect(selectReleaseNotesForLanguage(GREEK_ONLY_SECTION, language)).toBe(GREEK_ONLY_SECTION);
    }
  });

  it('shows the workflow fallback text unchanged', () => {
    for (const language of LANGUAGES) {
      expect(selectReleaseNotesForLanguage(WORKFLOW_FALLBACK, language)).toBe(WORKFLOW_FALLBACK);
    }
  });

  it('shows the whole text when no block matches the till, English or Greek', () => {
    const notes = section(['de', 'fr']);

    expect(selectReleaseNotesForLanguage(notes, 'it')).toBe(notes);
  });

  it('tolerates typed headings: curly apostrophe, trailing colon, CRLF line ends', () => {
    const notes = [
      '## 1.4.120',
      '',
      `### ${RELEASE_NOTES_LANGUAGE_HEADINGS.el}:`,
      '',
      BULLET.el,
      '',
      '### What’s new in this update',
      '',
      BULLET.en,
      '',
    ].join('\r\n');

    const english = selectReleaseNotesForLanguage(notes, 'en');
    expect(english).toContain(BULLET.en);
    expect(english).not.toContain(BULLET.el);

    const greek = selectReleaseNotesForLanguage(notes, 'el');
    expect(greek).toContain(BULLET.el);
    expect(greek).not.toContain(BULLET.en);
  });

  it('keeps sub-headings inside a block and stops a block at the next section', () => {
    const notes = [
      '## 1.4.120',
      '',
      block('el'),
      '',
      `### ${RELEASE_NOTES_LANGUAGE_HEADINGS.en}`,
      '',
      '#### Payments',
      '',
      BULLET.en,
      '',
      '## 1.4.119',
      '',
      '- Older section.',
    ].join('\n');

    const english = selectReleaseNotesForLanguage(notes, 'en');
    expect(english).toContain('#### Payments');
    expect(english).toContain(BULLET.en);
    expect(english).not.toContain('Older section');
  });
});

describe('getReleaseNotesHtml with a till language', () => {
  it('renders only the block in the till language', () => {
    const html = getReleaseNotesHtml(section(LANGUAGES), 'fr');

    expect(html).toContain('<h2>1.4.120</h2>');
    expect(html).toContain(`<h3>${RELEASE_NOTES_LANGUAGE_HEADINGS.fr}</h3>`);
    expect(html).toContain('<strong>Note française.</strong>');
    expect(html).not.toContain(RELEASE_NOTES_LANGUAGE_HEADINGS.el);
    expect(html).not.toContain('English note.');
  });

  it('renders an old Greek-only section the same as before', () => {
    expect(getReleaseNotesHtml(GREEK_ONLY_SECTION, 'en')).toBe(getReleaseNotesHtml(GREEK_ONLY_SECTION));
  });
});
