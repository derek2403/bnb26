# Vendored: @atlas-oracle/pull-oracle-consumer 1.0.0

- Source: npm package `@atlas-oracle/pull-oracle-consumer@1.0.0`
  (repository https://github.com/oracle-atlas/pull-oracle-consumer), `src/` only.
- License: BUSL-1.1 (Business Source License 1.1), copyright Atlas Oracle. File headers are kept unchanged.
- Not our code. SplitStock only inherits `PullOracleConsumerStandard` in `src/oracle/AtlasPullAdapter.sol`.
- The files use non-relative imports (`base/`, `libraries/`, `interfaces/`, `constants/`). They are resolved with
  context-scoped remappings in `contracts/foundry.toml` (`lib/atlas-pull/:base/=lib/atlas-pull/src/base/`, ...),
  so they cannot collide with our own paths.
