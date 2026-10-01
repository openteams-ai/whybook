/// <reference types="node" />
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  CodeMirrorMimeTypeService,
  EditorLanguageRegistry
} from '@jupyterlab/codemirror';
import { Signal } from '@lumino/signaling';

import * as kernelCode from '../kernelCode';
import { JobManager } from '../model/jobs';
import {
  prepareVariable,
  snippetCall,
  subshellConnection
} from '../model/kernel';
import {
  LANGUAGES,
  PYTHON,
  R,
  SAS,
  codeMimeType,
  languageOf,
  noSubshells,
  sasName,
  supports,
  unsupported,
  usesSubshells
} from '../model/languages';
import { firstLine } from '../model/notebook';
import type { IVariable } from '../tokens';

const R_CODE = join(
  __dirname,
  '..',
  '..',
  'whybook',
  'server',
  'kernel_code',
  'r'
);

describe('languageOf', () => {
  it('finds the adapter from language_info.name, in any case', () => {
    expect(languageOf('python')).toBe(PYTHON);
    expect(languageOf('Python')).toBe(PYTHON);
    expect(languageOf('R')).toBe(R);
    expect(languageOf('r')).toBe(R);
  });

  it('has none for another language, or before the kernel answers', () => {
    expect(languageOf('julia')).toBeNull();
    expect(languageOf('scala')).toBeNull();
    expect(languageOf('')).toBeNull();
    expect(languageOf(null)).toBeNull();
  });
});

describe('supports', () => {
  it('gives Python every feature', () => {
    for (const feature of [
      'variables',
      'analysis',
      'plots',
      'questions'
    ] as const) {
      expect(supports(PYTHON, feature)).toBe(true);
    }
  });

  it('gives R its variables and the analysis of its cells', () => {
    expect(supports(R, 'variables')).toBe(true);
    // Since 1 October 2026 (design iteration 1.79).
    expect(supports(R, 'analysis')).toBe(true);
    expect(supports(R, 'plots')).toBe(false);
    expect(supports(R, 'questions')).toBe(false);
  });

  it('gives a language without an adapter no feature', () => {
    expect(supports(null, 'variables')).toBe(false);
  });
});

describe('unsupported', () => {
  it('leaves every feature on before the kernel answers', () => {
    expect(unsupported('questions', null)).toBeNull();
    expect(unsupported('variables', null)).toBeNull();
  });

  it('leaves every feature on in Python', () => {
    for (const feature of [
      'variables',
      'analysis',
      'plots',
      'questions'
    ] as const) {
      expect(unsupported(feature, 'python')).toBeNull();
    }
  });

  it('says why a feature is off in R, and names the kernel', () => {
    expect(unsupported('variables', 'R')).toBeNull();
    expect(unsupported('questions', 'R')).toBe(
      'Questions need a Python kernel for now: their code, and the cells that AI writes, are Python. This kernel runs R.'
    );
    expect(unsupported('analysis', 'R')).toBeNull();
    expect(unsupported('analysis', 'julia')).toBe(
      'The columns each cell uses are read in a Python or R kernel. This kernel runs julia.'
    );
    expect(unsupported('plots', 'R')).toContain('need a Python kernel');
  });

  it('names the languages that list variables to a kernel of another', () => {
    expect(unsupported('variables', 'julia')).toBe(
      'Variables are listed in a Python or R kernel. This kernel runs julia.'
    );
  });
});

describe('the R adapter', () => {
  const args = { known: { df: 'x"y' }, names: ["it's", 'a\\b', 'café 😀'] };

  it('embeds every R file', () => {
    const files = readdirSync(R_CODE).sort();
    // The analysis of cells (design iteration 1.79), the listing, and the
    // facts and the frames of an agent that works in another notebook (1.69).
    expect(files).toEqual([
      'analyze_cells.R',
      'inspect_variables.R',
      'kernel_facts.R',
      'write_frames.R'
    ]);
    for (const file of files) {
      expect(kernelCode.r[file.replace(/\.R$/, '')]).toEqual(
        readFileSync(join(R_CODE, file), 'utf8')
      );
    }
    expect(R.call('write_frames', { frames: ['weekly'] })).toContain(
      'finally = rm(list = ".whybook_write_frames", envir = globalenv()))'
    );
  });

  it('calls the function with the arguments and removes it after', () => {
    const code = R.call('inspect_variables', args)!;
    expect(code.startsWith(kernelCode.rInspectVariables)).toBe(true);
    expect(code).toContain(
      'finally = rm(list = ".whybook_inspect_variables", envir = globalenv()))'
    );
    // The call is ASCII: JSON escapes the rest, and R reads the escapes.
    const call = code.slice(kernelCode.rInspectVariables.length);
    expect(/^[\x20-\x7e\n]*$/.test(call)).toBe(true);
    const literal = call.match(/fromJSON\((".*"), simplifyVector/)![1];
    // R reads the literal as a string, then jsonlite reads it as JSON.
    expect(JSON.parse(JSON.parse(literal))).toEqual(args);
  });

  it('sends an error as the result, as xeus-r drops errors of silent requests', () => {
    expect(R.call('inspect_variables', {})).toContain(
      'error = function(e) IRdisplay::publish_mimebundle(list("application/vnd.whybook.result+json" = list(error = conditionMessage(e))))'
    );
  });

  it('calls the analysis of cells, and has no region summary to call', () => {
    const code = snippetCall(
      'analyze_cells',
      { cells: [{ id: 'c', source: 'x <- 1' }], signatures: true },
      R
    );
    expect(code.startsWith(kernelCode.rAnalyzeCells)).toBe(true);
    expect(code).toContain('.whybook_analyze_cells(jsonlite::fromJSON(');
    expect(code).toContain(
      'finally = rm(list = ".whybook_analyze_cells", envir = globalenv()))'
    );
    expect(R.call('region_summary', {})).toBeNull();
    expect(() => snippetCall('region_summary', {}, R)).toThrow(
      'The view has no region_summary for R'
    );
  });

  it('names a column with [[ ]]', () => {
    expect(R.column('df', 'age')).toBe('df[["age"]]');
    expect(R.column('df', 'a "b" \\c')).toBe('df[["a \\"b\\" \\\\c"]]');
    expect(PYTHON.column('df', "it's")).toBe("df['it\\'s']");
  });

  it('gives the columns of an R frame R names', () => {
    const variable: IVariable = {
      name: 'df',
      label: 'df',
      kind: 'dataframe',
      rows: 5,
      columns: [
        { name: '', label: 'age', parent: '', kind: 'numeric', tag: 'num' }
      ]
    };
    expect(prepareVariable(variable, R).columns![0]).toMatchObject({
      name: 'df[["age"]]',
      parent: 'df',
      rows: 5
    });
    expect(prepareVariable(variable).columns![0].name).toBe("df['age']");
  });
});

describe('LANGUAGES', () => {
  it('lists each language once', () => {
    const names = LANGUAGES.flatMap(language => language.names);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the SAS adapter', () => {
  it('is the adapter of language_info.name sas, as sas_kernel gives it', () => {
    expect(languageOf('sas')).toBe(SAS);
    expect(languageOf('SAS')).toBe(SAS);
  });

  it('has no program for the kernel, so the view sends it none', () => {
    for (const name of [
      'inspect_variables',
      'analyze_cells',
      'region_summary',
      'plot_hooks',
      'table_rows'
    ]) {
      expect(SAS.call(name, {})).toBeNull();
    }
    expect(() => snippetCall('inspect_variables', {}, SAS)).toThrow(
      'The view has no inspect_variables for SAS'
    );
    for (const feature of [
      'variables',
      'analysis',
      'plots',
      'questions'
    ] as const) {
      expect(supports(SAS, feature)).toBe(false);
    }
  });

  it('names the language in the notes of the features that are off', () => {
    expect(unsupported('variables', 'sas')).toBe(
      'Variables are listed in a Python or R kernel. This kernel runs SAS.'
    );
    expect(unsupported('questions', 'sas')).toBe(
      'Questions need a Python kernel for now: their code, and the cells that AI writes, are Python. This kernel runs SAS.'
    );
  });

  it('reads the text of the three kinds of SAS comment', () => {
    expect(SAS.commentText('/* Visits by arm */')).toBe('Visits by arm');
    expect(SAS.commentText('  /** Visits by arm **/  ')).toBe('Visits by arm');
    expect(SAS.commentText('/* Visits by arm, over')).toBe(
      'Visits by arm, over'
    );
    expect(SAS.commentText('* Visits by arm;')).toBe('Visits by arm');
    expect(SAS.commentText('%* Visits by arm;')).toBe('Visits by arm');
    // Code, and code after a comment, are no comment.
    expect(SAS.commentText('proc freq data=visits;')).toBeNull();
    expect(SAS.commentText('/* arm */ proc freq data=visits;')).toBeNull();
    expect(SAS.commentText('* one; data a;')).toBeNull();
    expect(PYTHON.commentText('# Visits by arm')).toBe('Visits by arm');
    expect(R.commentText('x <- 1  # one')).toBeNull();
  });

  it('gives a cell the title of its first comment', () => {
    expect(firstLine('/* Visits by arm */\nproc freq;', SAS)).toBe(
      'Visits by arm'
    );
    expect(firstLine('proc freq data=visits;\nrun;', SAS)).toBe(
      'proc freq data=visits;'
    );
    // Without a language, as for a markdown cell, the # of a heading goes.
    expect(firstLine('## Visits\ntext')).toBe('Visits');
    expect(firstLine('# Load\nimport pandas', PYTHON)).toBe('Load');
  });

  it('names a column as PROC SQL does, with a name literal where needed', () => {
    expect(SAS.column('visits', 'age')).toBe('visits.age');
    expect(SAS.column('visits', "patient's id")).toBe(
      "visits.'patient''s id'n"
    );
    expect(sasName('a'.repeat(33))).toBe(`'${'a'.repeat(33)}'n`);
  });
});

describe('subshells by language', () => {
  it('runs branches in subshells in Python and R, and in no other language', () => {
    expect(usesSubshells('python')).toBe(true);
    expect(usesSubshells('R')).toBe(true);
    expect(usesSubshells('sas')).toBe(false);
    expect(usesSubshells('bash')).toBe(false);
    expect(usesSubshells(null)).toBe(false);
  });

  it('says why branches run one after another', () => {
    expect(noSubshells(true, 'python')).toBeNull();
    expect(noSubshells(false, 'R')).toBe(
      'This kernel has no subshells: branches run one after another in the main shell'
    );
    expect(noSubshells(true, 'sas')).toBe(
      'This kernel lists subshells and runs one SAS session behind them: branches run one after another in the main shell'
    );
    expect(noSubshells(true, 'bash')).toContain('runs one bash session');
  });

  /** A kernel that lists subshells, in the language of its info reply. */
  function kernelIn(language: string) {
    const created: string[] = [];
    const kernel: any = {
      supportsSubshells: true,
      connectionStatus: 'connected',
      info: Promise.resolve({ language_info: { name: language } }),
      // The notebook's connection asks for the subshell.
      requestCreateSubshell() {
        created.push(language);
        const reply = { content: { subshell_id: 's1' } };
        const future = {
          onReply: (msg: unknown): void => undefined,
          done: Promise.resolve(reply)
        };
        void Promise.resolve().then(() => future.onReply(reply));
        return future;
      },
      clone() {
        return { ...kernel, subshellId: null, dispose: () => undefined };
      }
    };
    return { kernel, created };
  }

  it('opens a subshell in a Python kernel and none in a SAS kernel that lists them', async () => {
    const python = kernelIn('python');
    expect((await subshellConnection(python.kernel))?.subshellId).toBe('s1');
    expect(python.created).toEqual(['python']);
    const sas = kernelIn('sas');
    expect(await subshellConnection(sas.kernel)).toBeNull();
    expect(sas.created).toEqual([]);
  });

  it('runs the branches of a SAS kernel one after another, and says why', async () => {
    const { kernel } = kernelIn('sas');
    const sessionContext: any = {
      session: { kernel },
      kernelChanged: new Signal({}),
      statusChanged: new Signal({})
    };
    const jobs = new JobManager({ sessionContext, rendermime: {} as any });
    await kernel.info;
    await Promise.resolve();
    expect(jobs.parallel).toBe(false);
    expect(jobs.serialReason).toContain('one SAS session behind them');
    jobs.dispose();
  });
});

describe('codeMimeType', () => {
  // JupyterLab's own registry of CodeMirror languages.
  const registry = new EditorLanguageRegistry();
  for (const language of EditorLanguageRegistry.getDefaultLanguages()) {
    registry.addLanguage(language);
  }
  const mimeTypes = new CodeMirrorMimeTypeService(registry);
  const notebook = (metadata: Record<string, unknown>) => ({
    getMetadata: (key: string) => metadata[key]
  });

  it('highlights a SAS notebook with the SAS mode, from its kernel or its kernelspec', () => {
    // The language info that "SAS (licence needed)" gives, as a notebook keeps it.
    const sas = {
      name: 'sas',
      mimetype: 'text/x-sas',
      file_extension: '.sas',
      codemirror_mode: 'sas'
    };
    expect(codeMimeType(notebook({ language_info: sas }), mimeTypes)).toBe(
      'text/x-sas'
    );
    expect(
      codeMimeType(
        notebook({
          language_info: { name: '' },
          kernelspec: { name: 'sas-licence-needed', language: 'sas' }
        }),
        mimeTypes
      )
    ).toBe('text/x-sas');
    expect(registry.findByMIME('text/x-sas')?.name).toBe('SAS');
  });

  it('keeps Python for a Python notebook and one that names no language, and gives R its own', () => {
    const python = {
      name: 'python',
      codemirror_mode: { name: 'ipython', version: 3 },
      mimetype: 'text/x-python',
      file_extension: '.py'
    };
    expect(codeMimeType(notebook({ language_info: python }), mimeTypes)).toBe(
      'text/x-ipython'
    );
    expect(codeMimeType(notebook({}), mimeTypes)).toBe('text/x-ipython');
    // xeus-r's language info: an empty codemirror_mode.
    const r = {
      name: 'R',
      mimetype: 'text/x-R',
      file_extension: '.R',
      codemirror_mode: ''
    };
    expect(codeMimeType(notebook({ language_info: r }), mimeTypes)).toBe(
      'text/x-rsrc'
    );
  });
});
