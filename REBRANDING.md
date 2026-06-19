# Rebranding Notes

This repository is a Pulse-branded fork of the upstream T3 Code project. Use this document as the rebase checklist when pulling upstream changes: new upstream naming should be translated to the Pulse conventions below.

## Product copy

- User-facing `T3 Code` copy becomes `Pulse`.
- `T3 Connect` becomes `Pulse Connect`.
- Compact/camel copy variants become `Pulse` too:
  - `T3Code` -> `Pulse`
  - `T3 code` -> `Pulse`
- If UI combines a T3 wordmark with the text `Code`, remove the wordmark and render `Pulse` as text.
  - Example: the settings sidebar renders plain `Pulse` and no longer imports the old `T3Wordmark` component.
- Splash/title/alt text should say `Pulse`.
- Stable/production desktop and mobile display names should be `Pulse` without an `(Alpha)` suffix.
- Non-stable display names may use explicit stage suffixes such as `Pulse (Dev)`, `Pulse (Preview)`, or `Pulse (Nightly)` as appropriate.

## Repository URLs and slugs

- Canonical repository URL: `https://github.com/chanyeinthaw/pulse`.
- Upstream GitHub slug references should be rewritten:
  - `pingdotgg/t3code` -> `chanyeinthaw/pulse`
- Pulse example clone/fork URLs, release URLs, and source-control fixtures should use the Pulse slug unless a test is intentionally exercising arbitrary third-party repositories.

## Environment variables, schemes, and runtime identifiers

The runtime prefix has been renamed from T3 Code to Pulse:

- Env vars:
  - `T3CODE_*` -> `PULSE_*`
  - `VITE_T3CODE_*` -> `VITE_PULSE_*`
- Lowercase identifiers:
  - `t3code` -> `pulse`
- Protocol schemes:
  - `t3code://` -> `pulse://`
  - `t3code-dev://` -> `pulse-dev://`
  - `t3code-preview://` -> `pulse-preview://`
- Bundle/app IDs and desktop metadata should use Pulse identifiers, for example `com.pulse.pulse` / `com.pulse.pulse.dev` where applicable.
- Local storage keys, temp prefixes, branch prefixes, update channels, executable names, and generated artifact names should use `pulse` rather than `t3code`.
- Hyphenated identifiers should use Pulse naming:
  - `t3-*` -> `pulse-*`
  - `T3-*` -> `Pulse-*`
  - `t3-relay` -> `pulse-relay`
  - `t3-code-*` -> `pulse-*`
- CLI snippets and remote-launch helpers should use `pulse` instead of `t3`, for example `npx pulse`, `pulse serve`, and `pulse connect`.

## Repository and package metadata

- Root package name:
  - `@t3tools/monorepo` -> `@pulse/monorepo`
- Workspace package scope:
  - `@t3tools/*` -> `@pulse/*`
- Server CLI package:
  - package name `t3` -> `pulse`
  - bin `t3` -> `pulse`
  - Vite+/workspace task refs `t3#build` -> `pulse#build`
- Relay package:
  - `t3code-relay` -> `pulse-relay`
- Oxlint plugin workspace:
  - directory `oxlint-plugin-t3code` -> `oxlint-plugin-pulse`
  - package `@t3tools/oxlint-plugin-t3code` -> `@pulse/oxlint-plugin-pulse`
  - oxlint plugin namespace/rule IDs `t3code/...` -> `pulse/...`
  - root workspace/build/plugin paths should point at `oxlint-plugin-pulse`.

After package name changes, run `pnpm install` so workspace links and `pnpm-lock.yaml` are refreshed.

## Pi native tools

The Pi browser automation helper was renamed from T3 to Pulse:

- `apps/server/src/provider/Layers/PiT3Tools.ts` -> `PiPulseTools.ts`
- `PiT3Tools.test.ts` -> `PiPulseTools.test.ts`
- `makePiT3Tools` -> `makePiPulseTools`
- `T3_PI_TOOL_NAMES` -> `PULSE_PI_TOOL_NAMES`
- Tool names:
  - `t3_capability` -> `pulse_capability`
  - `t3_execute` -> `pulse_execute`
- Tool labels:
  - `T3 Capability` -> `Pulse Capability`
  - `T3 Execute` -> `Pulse Execute`
- Prompt snippets, guidelines, and error messages should refer to Pulse-native capabilities and Pulse preview automation.

## Effect deterministic keys

Renaming package names changes Effect's expected deterministic service keys. Update keys to match the new package names when typecheck reports `effect(deterministicKeys)`:

- `@t3tools/...` -> `@pulse/...`
- `t3code-relay/...` -> `pulse-relay/...`
- `t3/...` -> `pulse/...`

## Imports and bundle filters

When package scopes change, update all source imports and bundler predicates:

- Source imports should use `@pulse/...` instead of `@t3tools/...`.
- Vite+ bundle predicates should check `id.startsWith("@pulse/")`.
- Task dependencies should reference `@pulse/...#build` package names.

## Icon/wordmark assets

- Remove T3 wordmark layers from icon composer JSON where they are only brand overlays.

## Mobile native modules

Mobile native module directories, filenames, exported native view names, native classes, generated codegen names, and Java/Kotlin package paths use Pulse naming:

- Directories:
  - `apps/mobile/modules/t3-composer-editor` -> `apps/mobile/modules/pulse-composer-editor`
  - `apps/mobile/modules/t3-markdown-text` -> `apps/mobile/modules/pulse-markdown-text`
  - `apps/mobile/modules/t3-review-diff` -> `apps/mobile/modules/pulse-review-diff`
  - `apps/mobile/modules/t3-terminal` -> `apps/mobile/modules/pulse-terminal`
- Native identifiers:
  - `T3ComposerEditor*` -> `PulseComposerEditor*`
  - `T3MarkdownText*` -> `PulseMarkdownText*`
  - `T3ReviewDiff*` -> `PulseReviewDiff*`
  - `T3Terminal*` -> `PulseTerminal*`
  - `expo.modules.t3terminal` -> `expo.modules.pulseterminal`
- Update Expo module configs, podspec paths/names, React Native codegen component names, TypeScript wrappers, tests, and `apps/mobile/package.json` file dependencies when these names change.

## Validation

Before handing off a rebranding change:

```bash
pnpm install # only when package/workspace names changed
vp run typecheck
vp check
```

`vp check` may report pre-existing lint warnings; formatting must pass and the command should exit successfully.

## Audit commands

Useful checks after pulling upstream:

```bash
rg "T3 Code|T3Code|T3 code|T3 Connect|T3CODE|t3code|t3-|T3-|t3-relay|pingdotgg/t3code|@t3tools|oxlint-plugin-t3code" \
  --glob '!node_modules' --glob '!.repos' --glob '!pnpm-lock.yaml'
```

This file intentionally contains the upstream tokens above as the migration reference; hits outside `REBRANDING.md` should be reviewed.
