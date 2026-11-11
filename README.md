# TDLib for Slow Reader

[TDLib](https://github.com/tdlib/td), Telegram’s own library, compiled to WebAssembly for [Slow Reader](https://github.com/hplush/slowreader). TDLib has no fresh npm package, and Slow Reader needs a build for its strict security rules.

The package version is the version of TDLib inside.

## Difference From TDLib’s Own Web Build

- ES module for a Web Worker.
- No `eval`, so it works with Content Security Policy without `unsafe-eval`.
- Fresh Emscripten and OpenSSL. Exact versions and hashes of all sources are in [`tdlib.lock`](./tdlib.lock).
- Only the library with TDLib’s JSON interface, without `tdweb` wrapper.

## Security

- **Pinned sources.** TDLib, Emscripten, OpenSSL, and zlib are downloaded by an exact version and checked by hash from [`tdlib.lock`](./tdlib.lock). Attackers can’t replace them on the download server.
- **Small build script.** The whole build is one [`build.ts`](./build.ts) without npm dependencies. You can read it in a few minutes, and there is no dependency, which could change the build.
- **Release only from CI.** Nobody builds the package on own laptop. [Release workflow](./.github/workflows/release.yml) builds it from the public commit, so a hacked maintainer’s machine can’t put a changed file into the package.
- **Provenance.** npm shows a signed proof of the commit and the workflow, which built every version. A package built anywhere else would not have it.
- **No npm token.** npm accepts the package only from our release workflow, so there is no secret to steal from the repository.
- **Separated publish job.** The compiler and other build tools run in a job without the right to publish. The job with this right only uploads the built package.
- **Staged publish.** CI can’t publish by itself. A maintainer checks every staged package and approves it with 2FA.

## Development

[New Version workflow](./.github/workflows/update.yml) checks for a new TDLib version every day. If there is one, it runs `node --run update`, pushes the commit to `main`, and starts the release.

[Release workflow](./.github/workflows/release.yml) builds the package and stages it on npm, when `package.json` in `main` has a version, which is not on npm yet. A maintainer checks the staged files and publishes them by `npm stage approve`.

- `node --run build`: build the library to `dist/`. It takes a long time and needs a C++ compiler, CMake, Make, gperf, Perl, Python, and xz. [Dev Container](./.devcontainer.json) has them.
- `node --run update`: move `tdlib.lock` and `package.json` to the latest TDLib version.
