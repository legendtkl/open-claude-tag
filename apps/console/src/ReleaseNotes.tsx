import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles, Wrench } from 'lucide-react';
import { releaseNotes as defaultReleaseNotes, type ReleaseNote } from './release-notes';

export type ReleaseNotesLocale = 'en' | 'zh';

/** Static, language-resolved labels for the release-notes page. */
export interface ReleaseNotesViewLabels {
  enhancements: string;
  fixes: string;
  empty: string;
}

export interface ReleaseNotesViewProps {
  locale: ReleaseNotesLocale;
  labels: ReleaseNotesViewLabels;
  /** Defaults to the shipped changelog; injectable for tests. */
  notes?: ReleaseNote[];
}

/**
 * Product-facing "Release Notes" workspace page. Purely presentational — the
 * changelog comes from the static `release-notes` data module. Each version is
 * a collapsible (accordion) section: the latest version is expanded by default,
 * older versions are collapsed, and each header toggles its own section.
 */
export function ReleaseNotesView({
  locale,
  labels,
  notes = defaultReleaseNotes,
}: ReleaseNotesViewProps) {
  // Latest version (first entry, newest-first data) is expanded by default.
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(
    () => new Set(notes[0] ? [notes[0].version] : []),
  );

  const toggle = (version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
    });
  };

  if (notes.length === 0) {
    return (
      <div className="release-notes-page">
        <p className="release-notes-empty">{labels.empty}</p>
      </div>
    );
  }

  return (
    <div className="release-notes-page">
      {notes.map((note) => {
        const expanded = expandedVersions.has(note.version);
        const regionId = `release-notes-${note.version}`;
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
          <article className="release-notes-entry" key={note.version}>
            <button
              aria-controls={regionId}
              aria-expanded={expanded}
              className="release-notes-accordion-header"
              onClick={() => toggle(note.version)}
              type="button"
            >
              <Chevron aria-hidden="true" size={16} />
              <span className="release-notes-version">v{note.version}</span>
              <span className="release-notes-date">{note.date}</span>
            </button>

            {expanded && (
              <div
                aria-label={`v${note.version}`}
                className="release-notes-body"
                id={regionId}
                role="region"
              >
                {note.highlights.length === 0 && note.fixes.length === 0 && (
                  <p className="release-notes-empty">{labels.empty}</p>
                )}

                {note.highlights.length > 0 && (
                  <section className="release-notes-group">
                    <h3 className="release-notes-group-title">
                      <Sparkles aria-hidden="true" size={14} />
                      {labels.enhancements}
                    </h3>
                    <ul>
                      {note.highlights.map((item) => (
                        <li key={item.en}>{item[locale]}</li>
                      ))}
                    </ul>
                  </section>
                )}

                {note.fixes.length > 0 && (
                  <section className="release-notes-group">
                    <h3 className="release-notes-group-title">
                      <Wrench aria-hidden="true" size={14} />
                      {labels.fixes}
                    </h3>
                    <ul>
                      {note.fixes.map((item) => (
                        <li key={item.en}>{item[locale]}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
