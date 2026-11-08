# modelschemas

## 0.2.3

### Patch Changes

- Updated dependencies [57f76fc]
- Updated dependencies [64fba2b]
  - @modelschemas/client@0.2.3
  - @modelschemas/codegen@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [efd04aa]
- Updated dependencies [653ed60]
- Updated dependencies [667b1d7]
- Updated dependencies [1780348]
- Updated dependencies [0dbb5aa]
  - @modelschemas/client@0.2.2
  - @modelschemas/codegen@0.2.2

## 0.2.1

### Patch Changes

- 589f284: Publish built JavaScript. Each package ships `dist/*.js` and `dist/*.d.ts`.
  `exports` and `main` point at `dist/`, and the CLI bin is the built file
  with a Node shebang. Plain Node can import the libraries and run
  `modelschemas --help` with no TypeScript loader.
- 589f284: **Breaking:** `rateCardSchema` moved from the `@modelschemas/rate-card`
  root to `@modelschemas/rate-card/schema`. The root no longer needs `zod`;
  install it only to import `./schema`.

  **Breaking:** the CLI, codegen, and vite declare `engines.node >= 22.18.0`.
  The CLI needs `import.meta.main`; on Node 20 it exited without running.

  client, codegen, and vite are `sideEffects: false`, and every package
  exports `./package.json`.

- Updated dependencies [589f284]
- Updated dependencies [bcbe8d0]
- Updated dependencies [3153d38]
- Updated dependencies [bb2ae17]
- Updated dependencies [b530d22]
- Updated dependencies [589f284]
- Updated dependencies [7210a10]
  - @modelschemas/client@0.2.1
  - @modelschemas/codegen@0.2.1
