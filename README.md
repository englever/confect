# Confect 🧁

## Englever satellite fork

This is [Englever's fork](https://github.com/englever/confect) of [Confect](https://github.com/rjdellecese/confect), maintained for Edcell.
It adds Convex component authoring, typed callbacks, declarative backend configuration, HTTP route labels, Alchemy cloud and local providers, component testing support, and CLI fixes. See [CHANGES.md](CHANGES.md) for patches and upstream status.

`englever/main` tracks stable upstream releases. A scheduled check tries the newest stable release and reports conflicts. A maintainer lands the rebase.

Fork builds publish as `@englever/confect-*` on GitHub Packages only after all checks in the same commit's Packages workflow pass. To publish on demand, run Packages on `englever/main`. Choose a green [Packages run](https://github.com/englever/confect/actions/workflows/packages.yml) that published a build.
Pin every alias to the same exact build. Do not use floating tags.

Configure your user `~/.npmrc` and supply `NODE_AUTH_TOKEN` through your environment with package read permission:

```ini
@englever:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Replace `<version>` with the build you chose. Aliases preserve `@confect/*` imports:

```sh
pnpm add --strict-peer-dependencies '@confect/core@npm:@englever/confect-core@<version>' '@confect/server@npm:@englever/confect-server@<version>' '@confect/test@npm:@englever/confect-test@<version>' '@confect/cli@npm:@englever/confect-cli@<version>'
```

Each successful install check uploads a consumer artifact with its pinned manifest, lockfile and install command; `bun scripts/consumerFixture.ts <dir> <version>` regenerates it.
The install check generates a declared backend and a component mounted at `/counter`, calls the component through the host, checks callback arguments and decodes callback results, and fetches the declared HTTP routes. PRs run it against packed tarballs before publication. Use "Publish fork builds" with an existing version to check a published build without publishing again.
Another repository's workflow token needs package read access granted separately.

Report problems in [englever/confect issues](https://github.com/englever/confect/issues). Fork additions are documented in [apps/docs](apps/docs).

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
