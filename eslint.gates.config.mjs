import baseConfig from './eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      complexity: ['error', { max: 10 }],
      'sonarjs/cognitive-complexity': ['error', 15],
      'max-lines-per-function': [
        'error',
        { max: 30, skipBlankLines: true, skipComments: true },
      ],
      'max-depth': ['error', 3],
      'max-lines': [
        'error',
        { max: 250, skipBlankLines: true, skipComments: true },
      ],
    },
  },
];
