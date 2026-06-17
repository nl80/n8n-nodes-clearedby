// n8n community-node lint rules (eslint-plugin-n8n-nodes-base). These are the
// same checks n8n runs during verified-community-node review, so passing this
// locally is our pre-flight for getting the ✓ badge / Cloud listing.
module.exports = {
  root: true,
  overrides: [
    {
      files: ['package.json'],
      plugins: ['eslint-plugin-n8n-nodes-base'],
      extends: ['plugin:n8n-nodes-base/community'],
      parser: 'jsonc-eslint-parser',
    },
    {
      files: ['credentials/**/*.ts'],
      plugins: ['eslint-plugin-n8n-nodes-base'],
      extends: ['plugin:n8n-nodes-base/credentials'],
      parser: '@typescript-eslint/parser',
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
    },
    {
      files: ['nodes/**/*.ts'],
      plugins: ['eslint-plugin-n8n-nodes-base'],
      extends: ['plugin:n8n-nodes-base/nodes'],
      parser: '@typescript-eslint/parser',
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
    },
  ],
}
