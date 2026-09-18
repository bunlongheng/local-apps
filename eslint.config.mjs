// Lint the Node/CommonJS backend (server.js, lib/, db.js, scripts, tests).
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['server.js', 'db.js', 'launchctl-cmds.js', 'lib/**/*.js', 'routes/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
        console: 'readonly', __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', URL: 'readonly', fetch: 'readonly', AbortController: 'readonly',
        AbortSignal: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        structuredClone: 'readonly', FormData: 'readonly', Blob: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': 'error',
    },
  },
  {
    // The app-restart rule, enforced by lint rather than a grep test: everywhere an app can be
    // started, the command must come from startCmd() in launchctl-cmds.js (the one place that
    // carries the bootstrap fallback). launchctl-cmds.js itself is the only file allowed the literal.
    files: ['server.js', 'db.js', 'lib/**/*.js', 'routes/**/*.js', 'scripts/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'Literal[value=/launchctl (kickstart|bootstrap)/]', message: 'inline launchctl kickstart/bootstrap: use startCmd() from launchctl-cmds.js so the enable + bootstrap + kickstart fallback is never lost' },
        { selector: 'TemplateElement[value.raw=/launchctl (kickstart|bootstrap)/]', message: 'inline launchctl kickstart/bootstrap: use startCmd() from launchctl-cmds.js so the enable + bootstrap + kickstart fallback is never lost' },
      ],
    },
  },
  {
    // The dashboard and the service worker run in the browser: script-scope, browser globals.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', history: 'readonly',
        fetch: 'readonly', EventSource: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', requestAnimationFrame: 'readonly',
        console: 'readonly', localStorage: 'readonly', Image: 'readonly', self: 'readonly', caches: 'readonly',
        Response: 'readonly', Request: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
      },
    },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }], 'no-empty': 'error' },
  },
];
