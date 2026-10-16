# Confect 🧁

## Englever satellite fork

This is [englever's fork](https://github.com/englever/confect) of
[Confect](https://github.com/rjdellecese/confect), maintained for Edcell.
It adds Convex component authoring and typed callbacks, declarative backend
configuration, reflected HTTP route labels, Alchemy cloud deployment and local
providers, component testing support, and CLI fixes. [CHANGES.md](CHANGES.md)
records each fork patch and its upstream status.

`englever/main` tracks stable upstream releases, currently 10.2.0, rather than
upstream's unreleased `main`. A daily check at 06:17 UTC tries the newest stable
release in a scratch branch and reports conflicts. An Englever maintainer lands
the actual rebase; the check never moves the fork branch.

### Install a fork build

Every push to `englever/main` runs the fork publisher. It stages all eight
packages as `@englever/confect-*` on GitHub Packages at
`<upstream-version>-englever.N`, keeping source names and imports as `@confect/*`.
Choose a successful [Publish fork builds run](https://github.com/englever/confect/actions/workflows/publish.yml)
whose fresh-consumer check passed, and pin every alias to the same exact version.
Publication can partially succeed, so avoid floating `latest` or `englever` tags.
The fork publisher leaves npm releases under `@confect/*` to upstream.

Build [`10.2.0-englever.13`](https://github.com/englever/confect/actions/runs/38723208185)
passed publication, strict install, installed codegen, typecheck, and a TestConfect
query. With Node.js 24 or later and pnpm 12.8.1, configure these placeholders in
your trusted user `~/.npmrc`, and supply `NODE_AUTH_TOKEN` through your environment
with permission to read the packages:

```ini
@englever:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

The verified consumer uses `effect@4.0.1`, `convex@1.46.0`,
`convex-test@0.0.60`, and `@effect/platform-node@4.0.1`. Its pnpm overrides pin
`effect`, `convex`, `@effect/platform-node`, and `@effect/platform-node-shared` to
those versions. Install the backend and test packages through aliases:

```sh
pnpm add --strict-peer-dependencies \
  '@confect/core@npm:@englever/confect-core@10.2.0-englever.13' \
  '@confect/server@npm:@englever/confect-server@10.2.0-englever.13' \
  '@confect/test@npm:@englever/confect-test@10.2.0-englever.13' \
  '@confect/cli@npm:@englever/confect-cli@10.2.0-englever.13'
```

Use the same alias pattern for `js`, `react`, `foldkit`, or `alchemy` as needed;
Alchemy requires `alchemy@2.0.0-beta.82`. The successful run's consumer artifact
includes the complete pinned manifest, pnpm policy, lockfile, and install command.
You can generate that recipe from this checkout with
`bun scripts/consumerFixture.ts <new-directory> 10.2.0-englever.13`.
Another repository's workflow token needs package read access granted separately;
the fork's install check proves access only for its own token.

Report fork problems in [englever/confect issues](https://github.com/englever/confect/issues).
The upstream documentation below describes Confect generally; fork additions are
documented in this checkout's [apps/docs](apps/docs).

## About Confect

Confect is a framework that deeply integrates Effect with Convex. It's more than just Effect bindings! Confect allows you to:

- Define your Convex database schema using Effect schemas.
- Write Convex function args and returns validators using Effect's schema library.
- Use Confect functions to automatically decode and encode your data according to your Effect schema definitions for end-to-end rich types, from client to function to database (and back).
- Add reusable, type-safe middleware to function groups or individual functions to provide Effect services and run logic around handlers.
- Declare typed errors on functions and middleware using Effect schemas, then handle the decoded errors at every call site.
- Use Effect's native HTTP API modules to define your HTTP API.
- Access Convex platform capabilities via Effect services.

Want to learn more? Read the [docs](https://confect.dev)!
