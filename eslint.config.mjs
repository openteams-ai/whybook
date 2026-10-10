import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import jupyterPlugin from '@jupyter/eslint-plugin';
import signalLifetime from '@jupyter/eslint-plugin/lib/utils/signal-lifetime.js';

// The senders that live as long as the application, for the two rules on
// signal connections. The option replaces the plugin's list, so the list
// starts with the plugin's own. JupyterLab core adds the kernel session
// types: a session outlives the views of its document, as the notebook view
// outlives a Whybook view of the same file. Whybook adds its two objects
// that the plugin makes once, in its activate function.
const LONG_LIVED_TYPES = [
  ...signalLifetime.DEFAULT_LONG_LIVED_TYPES,
  'SessionContext',
  'IKernelConnection',
  'KernelConnection',
  'EpiSettings',
  'CurrentModel'
];

// Test files, which may use `any`, as JupyterLab core's may.
const TESTS = [
  'src/__tests__/**/*.ts',
  'src/__tests__/**/*.tsx',
  'ui-tests/**/*.ts'
];

export default defineConfig([
  globalIgnores([
    'node_modules',
    'dist',
    'coverage',
    '**/*.js',
    '**/*.d.ts',
    '.venv',
    'src/kernelCode.ts'
  ]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    }
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: {
      jupyter: jupyterPlugin
    }
  },
  jupyterPlugin.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2015,
        ...globals.node
      },
      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module'
      }
    },
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: {
            regex: '^I[A-Z]',
            match: true
          }
        }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', ignoreRestSiblings: true }
      ],
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      // Type correctness, as in JupyterLab core.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/non-nullable-type-assertion-style': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' }
      ],
      // A request whose promise nobody awaits fails without a trace.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true }
      ],
      'no-useless-assignment': 'error',
      eqeqeq: 'error',
      // The rules of @jupyter/eslint-plugin, at JupyterLab core's severity.
      'jupyter/command-described-by': 'error',
      'jupyter/plugin-description': 'error',
      'jupyter/no-pageconfig-base-url': 'error',
      'jupyter/require-signal-cleanup': [
        'error',
        { longLivedTypes: LONG_LIVED_TYPES }
      ],
      'jupyter/prefer-signal-this-arg': [
        'error',
        { longLivedTypes: LONG_LIVED_TYPES }
      ],
      'jupyter/require-disposable-ownership': 'error',
      'jupyter/require-disposable-transfer': 'error',
      'jupyter/prefer-lazy-imports': [
        'error',
        {
          // The plugin builds its side panels, its status items and its
          // settings editors in activate, and ./widgets imports the rest of
          // the view. An await import() of one of these would still load it
          // before JupyterLab shows its window, which waits for every plugin
          // to activate. The check-up's plugin (./checkup.ts) draws its
          // section in the Exploration panel and records run times from the
          // first view, so it needs its three modules at start too. So does
          // the plugin of another kernel (./reproduce.ts), which adds the
          // Check-up's rows for each kernel once the kernels are listed; its
          // module loads with the view model, which imports it. The Kernel
          // menu's items for the view (./kernelmenu) register with the main
          // menu at start, as the notebook's do. On an edit page of Jupyter
          // Notebook 7 the plugin registers the rule that sends the page to
          // the notebook's page (./notebook7) before the router runs, which
          // an await import() could miss. The rule checks every other
          // import.
          ignoreImports: [
            './contextmenu',
            './databases',
            './kernelmenu',
            './model/api',
            './model/checkup',
            './model/crosskernel',
            './model/epimodel',
            './model/libraries',
            './model/settings',
            './notebook7',
            './ui/checkup',
            './ui/datapolicy',
            './ui/exploration',
            './ui/founddefaults',
            './ui/modelsfield',
            './ui/runs',
            './ui/settingcards',
            './ui/variables',
            './widgets'
          ]
        }
      ],
      // Translations are not part of v1.
      'jupyter/no-untranslated-string': 'off',
      'jupyter/no-translation-concatenation': 'off',
      'jupyter/no-dynamic-translation': 'off',
      'jupyter/incorrect-translator-usage': 'off'
    }
  },
  {
    files: TESTS,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // A test loads its modules up front, has no commands of its own, and
      // drops what it made with the page or the jest environment.
      'jupyter/prefer-lazy-imports': 'off',
      'jupyter/command-described-by': 'off',
      'jupyter/no-pageconfig-base-url': 'off',
      'jupyter/require-disposable-ownership': 'off',
      'jupyter/require-disposable-transfer': 'off'
    }
  },
  {
    // The jest tests: galata's helpers and expect.soft are Playwright's.
    files: ['src/__tests__/**/*.ts', 'src/__tests__/**/*.tsx'],
    rules: {
      'jupyter/galata-prefer-filebrowser-helper': 'off',
      'jupyter/galata-prefer-menu-helper': 'off',
      'jupyter/galata-prefer-notebook-cell-helper': 'off',
      'jupyter/galata-prefer-sidebar-activity-helper': 'off',
      'jupyter/require-soft-assertions-before-snapshots': 'off'
    }
  },
  {
    files: ['ui-tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: 'ui-tests/tsconfig.json'
      }
    },
    rules: {
      'jupyter/galata-prefer-filebrowser-helper': 'error',
      'jupyter/galata-prefer-menu-helper': 'error',
      'jupyter/galata-prefer-notebook-cell-helper': 'error',
      // Its advice for a tab of the main area, page.activity.activateTab,
      // clicks a tab only when one tab has the name: a Whybook view and
      // the notebook view of the same file have two.
      'jupyter/galata-prefer-sidebar-activity-helper': 'off',
      'jupyter/require-soft-assertions-before-snapshots': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='waitForTimeout']",
          message:
            'Do not wait a fixed time: check with a web-first assertion or expect.poll (TESTING.md).'
        },
        {
          selector:
            "CallExpression[callee.property.name='screenshot'] > ObjectExpression > Property[key.name='path']",
          message:
            "Do not pass 'path' to screenshot(). Save the result of toMatchSnapshot() or use expect() assertions instead."
        },
        {
          selector:
            "CallExpression[callee.object.object.name='test'][callee.object.property.name='describe'][callee.property.name='configure'] > ObjectExpression > Property[key.name='mode'][value.value='serial']",
          message:
            "Do not use test.describe.configure({ mode: 'serial' }): a failed test would skip the rest of its file."
        }
      ]
    }
  },
  {
    // JupyterLab's settings editor shows the title of each choice of a
    // oneOf, where it shows the bare values of an enum.
    files: ['schema/*.json'],
    rules: {
      'jupyter/no-schema-enum': 'error'
    }
  },
  prettierRecommended,
  {
    // After prettier's config, which turns curly off: with 'all' it cannot
    // disagree with prettier.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      curly: ['error', 'all']
    }
  }
]);
