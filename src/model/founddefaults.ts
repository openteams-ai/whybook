/**
 * Library defaults that a model found in the signatures of the functions
 * that a cell calls: design iteration 1.53, the setting "Find more defaults
 * with AI", on by default.
 *
 * With the setting on, the kernel's analysis of each cell also lists the
 * library functions that the cell calls, each with every parameter that has
 * a default, and each call with the parameters that it leaves at their
 * defaults (whybook/server/kernel_code/analyze_cells.py, and its R version
 * in kernel_code/r, whose functions carry their package and `language`
 * "R", as `stats::t.test`). The model chosen
 * for More questions reads each function's signature once: it picks the
 * parameters whose default can change the result, puts them in order, and
 * says why each one matters (whybook/server/library_defaults.py). The server
 * keeps the answer for the library's version, so a function of one version
 * is asked about once. The picks show as chips with the cell's other chips,
 * marked as a model's choice. With the setting off, nothing changes.
 */
import type { IDecision, IDecisionCall, IWrittenBy } from '../tokens';
import type { Api, IKeptDefaults } from './api';
import { callsOf, shortFunction, shortName } from './decisions';

/** A parameter with a default, as the kernel lists it: the default as code. */
export interface ISignatureParam {
  name: string;
  default?: string | null;
  /** The default holds data, such as a frame: `default` says its type and size. */
  data?: boolean;
}

/** One call of a function, with the parameters that it leaves at their defaults. */
export interface ISignatureCall extends IDecisionCall {
  defaulted: string[];
}

/** A library function that a cell calls, as the kernel's analysis lists it. */
export interface ISignature {
  /** The qualified name: `pandas.core.frame.DataFrame.groupby`. */
  function: string;
  /** The name that the chips give: `DataFrame.groupby`. */
  name: string;
  module: string;
  library: string;
  version: string | null;
  /** The language of the library, which the model's prompt names: "R"; Python without it. */
  language?: string;
  params: ISignatureParam[];
  calls: ISignatureCall[];
}

/** A parameter that a model picked, and why its default matters. */
export interface IPick {
  param: string;
  why: string;
}

/** What a model picked from one function's signature, in its order, and which model. */
export interface IFunctionPicks {
  picks: IPick[];
  by: IWrittenBy | null;
}

/** The chips that one cell gets from the picks, at most. */
export const MAX_FOUND = 3;

/** A function of one version of its library, as the server keeps its answer. */
export function functionKey(
  signature: Pick<ISignature, 'function' | 'library' | 'version'>
): string {
  return JSON.stringify([
    signature.library,
    signature.version ?? '',
    signature.function
  ]);
}

/** Whether a decision of the cell shows this parameter of this call already, such as merge's `how`. */
function shownAt(
  shown: IDecision[],
  param: string,
  func: string,
  call: IDecisionCall
): boolean {
  return shown.some(decision => {
    if (decision.param !== param || shortFunction(decision) !== func) {
      return false;
    }
    const calls = callsOf(decision);
    // A decision kept before calls were listed stands for every call.
    return (
      calls.length === 0 ||
      calls.some(item => item.line === call.line && item.col === call.col)
    );
  });
}

/**
 * The decisions that a cell gets from the picks: for each function that
 * the cell calls, each picked parameter that a call leaves at its default,
 * with the calls that leave it. They come in the model's order: the first
 * pick of each function, in the order of the code, then the second, and so
 * on, up to `max`. A parameter that a decision of the cell shows already,
 * such as the inner join of a merge, is left out. The note is the model's
 * reason, and `found` says which model picked it from which library.
 */
export function foundDecisions(
  signatures: ISignature[],
  answer: (signature: ISignature) => IFunctionPicks | null | undefined,
  shown: IDecision[],
  max = MAX_FOUND
): IDecision[] {
  const found: { rank: number; order: number; decision: IDecision }[] = [];
  signatures.forEach((signature, order) => {
    const picks = answer(signature);
    if (!picks) {
      return;
    }
    const func = shortName(signature.name);
    picks.picks.forEach((pick, rank) => {
      const param = signature.params.find(item => item.name === pick.param);
      if (!param || typeof param.default !== 'string') {
        return;
      }
      const calls = signature.calls
        .filter(
          call =>
            call.defaulted.includes(pick.param) &&
            !shownAt(shown, pick.param, func, call)
        )
        .map(call => ({
          line: call.line,
          col: call.col,
          target: call.target ?? null
        }));
      if (calls.length === 0) {
        return;
      }
      found.push({
        rank,
        order,
        decision: {
          name: pick.param,
          value: param.default,
          provenance: 'library_default',
          param: pick.param,
          function: signature.name,
          note: pick.why,
          calls,
          found: {
            by: picks.by,
            library: signature.library,
            version: signature.version
          }
        }
      });
    });
  });
  return found
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, max)
    .map(item => item.decision);
}

/**
 * A cell's decisions with those that a model found: after the values that
 * nobody chose, the defaults of the analyst's modules and of the libraries,
 * and before the values that somebody chose.
 */
export function withFound(
  decisions: IDecision[],
  found: IDecision[]
): IDecision[] {
  if (found.length === 0) {
    return decisions;
  }
  let at = 0;
  decisions.forEach((decision, index) => {
    if (
      decision.provenance === 'defaulted' ||
      decision.provenance === 'library_default'
    ) {
      at = index + 1;
    }
  });
  return [...decisions.slice(0, at), ...found, ...decisions.slice(at)];
}

/** A function as the server reads it: its signature, without the calls of the notebook. */
function asked(signature: ISignature): Omit<ISignature, 'calls'> {
  const { calls: _calls, ...rest } = signature;
  return rest;
}

/** Where the answer about a function stands, while none is known. */
type State = 'looking' | 'missing' | 'asking' | 'failed';

/**
 * The answers about the library functions that the notebook's cells call.
 * The server's kept answers come first, without a model; then the model
 * chosen for More questions reads each function that has none, one at a
 * time, while it can run. The answers stay while the page is open. A call
 * that fails is not made again, unless another model is chosen.
 */
export class FoundDefaults {
  constructor(options: FoundDefaults.IOptions) {
    this._api = options.api;
    this._enabled = options.enabled;
    this._ready = options.ready;
    this._model = options.model;
    this._changed = options.changed;
  }

  /** Changes each time an answer comes, so that the cells make their chips again. */
  get version(): number {
    return this._version;
  }

  /** The model's picks for a function, or undefined while none is known. */
  answer(signature: ISignature): IFunctionPicks | undefined {
    return this._answers.get(functionKey(signature));
  }

  /**
   * The functions among these whose answer is on its way, by the names that
   * the chips give: the server looks for a kept answer, or a model reads the
   * signature now or next. None while no model can run.
   */
  waiting(signatures: ISignature[]): string[] {
    if (!this._enabled()) {
      return [];
    }
    const ready = this._ready();
    const names = signatures
      .filter(signature => {
        const state = this._states.get(functionKey(signature));
        return (
          state === 'looking' ||
          state === 'asking' ||
          (state === 'missing' && ready)
        );
      })
      .map(signature => signature.name);
    return [...new Set(names)];
  }

  /**
   * Find the answers about these functions: the ones that the server kept,
   * then a model's for the others, while the setting is on and the model
   * can run. Call it again when the model can run.
   */
  update(signatures: ISignature[]): void {
    if (!this._enabled()) {
      return;
    }
    const model = this._model();
    if (model !== this._lastModel) {
      // Another model gets its own try at the functions the last one failed on.
      this._lastModel = model;
      for (const [key, state] of this._states) {
        if (state === 'failed') {
          this._states.delete(key);
        }
      }
    }
    const unseen: ISignature[] = [];
    for (const signature of signatures) {
      const key = functionKey(signature);
      this._signatures.set(key, signature);
      if (!this._answers.has(key) && !this._states.has(key)) {
        this._states.set(key, 'looking');
        unseen.push(signature);
      }
    }
    if (unseen.length > 0) {
      void this._lookUp(unseen);
    }
    this._next();
  }

  private async _lookUp(signatures: ISignature[]): Promise<void> {
    let kept: IKeptDefaults[] = [];
    try {
      kept = (
        await this._api.libraryDefaults({ functions: signatures.map(asked) })
      ).answers;
    } catch (error) {
      // The model is asked; the server answers with what it kept, if it did.
      console.warn('Could not read the kept library defaults', error);
    }
    for (const signature of signatures) {
      const key = functionKey(signature);
      const found = kept.find(item => functionKey(item) === key);
      if (found) {
        this._answers.set(key, { picks: found.picks, by: found.by ?? null });
        this._states.delete(key);
      } else if (this._states.get(key) === 'looking') {
        this._states.set(key, 'missing');
      }
    }
    if (kept.length > 0) {
      this._version++;
    }
    // The bar of a function that no model can read now goes.
    this._changed();
    this._next();
  }

  /** Ask the model about the next function that has no answer, one at a time. */
  private _next(): void {
    if (this._busy || !this._enabled() || !this._ready()) {
      return;
    }
    const key = [...this._states].find(([, state]) => state === 'missing')?.[0];
    const signature = key ? this._signatures.get(key) : undefined;
    if (!key || !signature) {
      return;
    }
    this._busy = true;
    this._states.set(key, 'asking');
    this._changed();
    const model = this._model();
    let answered = false;
    void this._api
      .askLibraryDefaults({ model, function: asked(signature) }, event => {
        if (event.type === 'result' && Array.isArray(event.picks)) {
          const by = (event.by as IWrittenBy | undefined) ?? null;
          this._answers.set(key, { picks: event.picks as IPick[], by });
          answered = true;
        }
      })
      .catch(error =>
        console.warn(`Could not read the defaults of ${signature.name}`, error)
      )
      .then(() => {
        if (answered) {
          this._states.delete(key);
          this._version++;
        } else {
          // Not asked again in this session: a failure costs one call.
          this._states.set(key, 'failed');
        }
        this._busy = false;
        this._changed();
        this._next();
      });
  }

  private _api: Api;
  private _enabled: () => boolean;
  private _ready: () => boolean;
  private _model: () => string;
  private _changed: () => void;
  private _lastModel: string | null = null;
  private _busy = false;
  private _version = 0;
  private _answers = new Map<string, IFunctionPicks>();
  private _states = new Map<string, State>();
  private _signatures = new Map<string, ISignature>();
}

export namespace FoundDefaults {
  export interface IOptions {
    api: Api;
    /** Whether the setting "Find more defaults with AI" is on. */
    enabled: () => boolean;
    /** Whether the model of More questions can run now, under the notebook's cap. */
    ready: () => boolean;
    /** Which model: 'remote', or the id of a local model. */
    model: () => string;
    /** Called when an answer comes or a call starts or ends, so that the view updates. */
    changed: () => void;
  }
}
