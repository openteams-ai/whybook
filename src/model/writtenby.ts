import type { IEpiCellMeta, IWrittenBy } from '../tokens';
import { isRemote } from './models';

/** The earlier notes of a table or a frame, one per other model, at most. */
const EARLIER = 4;

interface INoted {
  by?: IWrittenBy;
}

/** A record of the AI that answered now. */
export function writtenBy(
  choice: string,
  model?: string | null,
  file?: string | null
): IWrittenBy {
  return {
    choice,
    model: model ?? null,
    ...(file ? { file } : {}),
    at: new Date().toISOString()
  };
}

/**
 * The note to show while `choice` is the model chosen, and whether that
 * model should write one. A note of the chosen model shows as it is.
 * Otherwise the newest note shows, with the model that wrote it, while the
 * chosen model writes its own. A note kept before the view recorded models,
 * or one that a script wrote in place of a model, as in the demos, is not
 * asked of the remote model again, which would spend the analyst's plan on
 * a label that is already there; a local model writes its own.
 */
export function noteFor<T extends INoted>(
  entry: (T & { earlier?: T[] }) | null | undefined,
  choice: string,
  usable: (note: T) => boolean = () => true
): { note: T | null; ask: boolean } {
  if (!entry) {
    return { note: null, ask: true };
  }
  const { earlier, ...newest } = entry;
  const notes = [newest as unknown as T, ...(earlier ?? [])].filter(usable);
  const own = notes.find(note => note.by?.choice === choice);
  if (own) {
    return { note: own, ask: false };
  }
  const shown = notes[0] ?? null;
  if (!shown) {
    return { note: null, ask: true };
  }
  const standIn = !shown.by || shown.by.choice === 'script';
  return { note: shown, ask: standIn ? !isRemote(choice) : true };
}

/** The entry with `note` as the newest, and one earlier note per other model. */
export function withNote<T extends INoted>(
  entry: (T & { earlier?: T[] }) | null | undefined,
  note: T
): T & { earlier?: T[] } {
  const previous: T[] = [];
  if (entry) {
    const { earlier, ...newest } = entry;
    previous.push(newest as unknown as T, ...(earlier ?? []));
  }
  // Notes without a record count as one model.
  const seen = new Set([note.by?.choice ?? '']);
  const kept = previous
    .filter(old => {
      const choice = old.by?.choice ?? '';
      if (seen.has(choice)) {
        return false;
      }
      seen.add(choice);
      return true;
    })
    .slice(0, EARLIER);
  return kept.length ? { ...note, earlier: kept } : { ...note };
}

/**
 * The AI that wrote a cell, from its metadata. Cells written before the
 * view recorded the choice came from the remote model, the only one that
 * writes cells.
 */
export function cellWrittenBy(
  generated: IEpiCellMeta['generated_by']
): IWrittenBy | null {
  if (!generated) {
    return null;
  }
  return {
    choice: generated.choice ?? 'remote',
    model: generated.model ?? null,
    at: generated.at ?? ''
  };
}

/**
 * Who wrote a cell's code, in words for Cell details. The view marks the
 * code it writes, from a template or a model, with `written_by: "agent"`, a
 * model's code also with `generated_by`, which names the model, and since 28
 * September 2026 a template's with `template`. Code with none of these marks
 * is the analyst's.
 */
export function codeWriter(meta: IEpiCellMeta): string {
  const written = cellWrittenBy(meta.generated_by);
  if (meta.written_by === 'user' || (!written && meta.written_by !== 'agent')) {
    return 'You wrote the code.';
  }
  if (!written && meta.template) {
    return 'The view wrote the code from a template, with no model call.';
  }
  return written
    ? describeBy(written)
    : 'The view wrote the code, from a template or with an AI model; the notebook does not record which.';
}

/** Who wrote or chose something, in words for the AI tag's tooltip. */
export function describeBy(
  by: IWrittenBy | null | undefined,
  verb = 'Written'
): string {
  if (!by) {
    return `${verb} by an AI model; the notebook does not record which`;
  }
  const who = isRemote(by.choice)
    ? `the remote AI model${by.model ? `, ${by.model}` : ''}`
    : by.choice === 'jev'
      ? 'Jev, by TypeSafe'
      : by.choice === 'script'
        ? `${by.model ?? 'a script'} from the table's numbers, in place of an AI model`
        : `${by.model ?? by.choice}, a local model`;
  const date = new Date(by.at);
  const when = isNaN(date.getTime())
    ? ''
    : ` on ${date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      })}`;
  return `${verb} by ${who}${when}`;
}
