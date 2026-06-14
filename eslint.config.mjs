import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.vite/**',
      '**/node_modules/**',
      'tmp/**',
      // Gitignored runtime data, incl. public-repo export snapshots.
      'data/**',
      // Gitignored scratch dumps/scripts from dev-DB resets.
      '.backups/**',
      '**/prisma/migrations/**',
      // Gitignored standalone (SEA) build outputs and download cache.
      'apps/bridge/release/**',
      'apps/bridge/.cache/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-alert': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'confirm',
          message: 'Use the shared prompt dialog hook instead of the native browser confirm dialog.'
        },
        {
          name: 'prompt',
          message: 'Use the shared prompt dialog hook instead of the native browser prompt dialog.'
        }
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'confirm',
          message: 'Use the shared prompt dialog hook instead of the native browser confirm dialog.'
        },
        {
          object: 'window',
          property: 'prompt',
          message: 'Use the shared prompt dialog hook instead of the native browser prompt dialog.'
        },
        {
          object: 'globalThis',
          property: 'confirm',
          message: 'Use the shared prompt dialog hook instead of the native browser confirm dialog.'
        },
        {
          object: 'globalThis',
          property: 'prompt',
          message: 'Use the shared prompt dialog hook instead of the native browser prompt dialog.'
        }
      ]
    }
  }
)
