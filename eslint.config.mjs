// Lint the Node/CommonJS backend (server.js, lib/, db.js, scripts, tests).
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'public/**'] },
  {
    files: ['server.js', 'db.js', 'launchctl-cmds.js', 'launchd-parse.js', 'lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
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
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
