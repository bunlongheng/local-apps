// Lint the Node/CommonJS backend (server.js, lib/, db.js, scripts, tests).
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['server.js', 'db.js', 'launchctl-cmds.js', 'lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
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
