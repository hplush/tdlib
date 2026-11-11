// Build TDLib to WebAssembly in dist/ from sources pinned by hash
// in tdlib.lock. It does nothing, if dist/ was already built from the same lock.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { join } from 'node:path'
import { styleText } from 'node:util'

const ROOT = import.meta.dirname
const SRC = join(ROOT, 'src')
const BUILD = join(ROOT, 'build')
const DIST = join(ROOT, 'dist')

interface Lock {
  emscripten: { release: string; sha256: string; version: string }
  openssl: { sha256: string; version: string }
  tdlib: { commit: string; sha256: string }
  zlib: { sha256: string; version: string }
}

let lockText = readFileSync(join(ROOT, 'tdlib.lock'), 'utf8')
let lock = JSON.parse(lockText) as Lock

let archives = {
  emscripten: {
    file: 'emscripten.tar.xz',
    sha256: lock.emscripten.sha256,
    url:
      'https://storage.googleapis.com/webassembly/emscripten-releases-builds/' +
      `linux/${lock.emscripten.release}/wasm-binaries.tar.xz`
  },
  openssl: {
    file: 'openssl.tar.gz',
    sha256: lock.openssl.sha256,
    url:
      'https://github.com/openssl/openssl/releases/download/' +
      `openssl-${lock.openssl.version}/openssl-${lock.openssl.version}.tar.gz`
  },
  tdlib: {
    file: 'tdlib.tar.gz',
    sha256: lock.tdlib.sha256,
    url: `https://github.com/tdlib/td/archive/${lock.tdlib.commit}.tar.gz`
  },
  // Emscripten port of this SDK version must want the same zlib version
  zlib: {
    file: 'zlib.tar.gz',
    sha256: lock.zlib.sha256,
    url: `https://github.com/madler/zlib/archive/refs/tags/v${lock.zlib.version}.tar.gz`
  }
}

type Name = keyof typeof archives

function print(message: string): void {
  process.stderr.write(styleText('bold', message) + '\n')
}

function isVerified(name: Name): boolean {
  let path = join(SRC, archives[name].file)
  return (
    existsSync(path) &&
    createHash('sha256').update(readFileSync(path)).digest('hex') ===
      archives[name].sha256
  )
}

async function download(): Promise<void> {
  mkdirSync(SRC, { recursive: true })
  for (let name of Object.keys(archives) as Name[]) {
    if (isVerified(name)) continue
    let { file, url } = archives[name]
    print(`Downloading ${url}`)
    let response = await fetch(url)
    if (!response.ok) throw new Error(`${response.status} from ${url}`)
    writeFileSync(join(SRC, file), Buffer.from(await response.arrayBuffer()))
    if (!isVerified(name)) {
      rmSync(join(SRC, file))
      throw new Error(`Wrong SHA-256 of ${url}`)
    }
  }
}

function unpack(name: Name, dir: string, ...args: string[]): void {
  rmSync(dir, { force: true, recursive: true })
  mkdirSync(dir, { recursive: true })
  execFileSync(
    'tar',
    ['-xf', join(SRC, archives[name].file), '-C', dir, ...args],
    { stdio: 'inherit' }
  )
}

function unpackRoot(name: Name): string {
  let dir = join(BUILD, name)
  unpack(name, dir, '--strip-components=1')
  return dir
}

function build(): void {
  let emscripten = unpackRoot('emscripten')
  let openssl = unpackRoot('openssl')
  let tdlib = unpackRoot('tdlib')

  let version = /^project\(TDLib VERSION ([\d.]+)/m.exec(
    readFileSync(join(tdlib, 'CMakeLists.txt'), 'utf8')
  )?.[1]
  let expected = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string
    }
  ).version
  if (version !== expected) {
    throw new Error(`Sources have TDLib ${version}, package.json ${expected}`)
  }

  // TDLib’s file is for Emscripten 3.1.1 and throws in the current one.
  // It only exported `FS`, which the current one exports by build settings.
  writeFileSync(join(tdlib, 'post.js'), '')
  // Emscripten downloads zlib during the build, if its cache has no sources
  // with the mark of the expected URL
  let zlib = join(emscripten, 'emscripten/cache/ports/zlib')
  unpack('zlib', zlib)
  writeFileSync(join(zlib, '.emscripten_url'), archives.zlib.url + '\n')

  let config = join(BUILD, 'emscripten.config')
  writeFileSync(
    config,
    `LLVM_ROOT = '${emscripten}/bin'\n` +
      `BINARYEN_ROOT = '${emscripten}'\n` +
      `NODE_JS = '${process.execPath}'\n`
  )
  let env = {
    ...process.env,
    EM_CONFIG: config,
    // To not have paths of the build machine in the files
    EMCC_CFLAGS: `-ffile-prefix-map=${BUILD}=.`,
    PATH: `${emscripten}/emscripten:${process.env.PATH}`
  }
  // TDLib build is memory hungry, so 2 GB of memory for every job
  let jobs = String(
    Math.max(1, Math.min(availableParallelism(), totalmem() / 2 / 1024 ** 3)) |
      0
  )

  function run(cwd: string, command: string, ...args: string[]): void {
    execFileSync(command, args, { cwd, env, stdio: 'inherit' })
  }

  print('Building OpenSSL')
  run(
    openssl,
    './Configure',
    'linux-generic32',
    'no-apps',
    'no-asm',
    'no-docs',
    'no-dso',
    'no-engine',
    'no-shared',
    'no-tests',
    'no-threads',
    'no-ui-console',
    'CC=emcc',
    'AR=emar',
    'RANLIB=emranlib',
    'CFLAGS=-Os'
  )
  run(openssl, 'make', '-j', jobs, 'build_libs')

  print('Generating TDLib sources')
  let generate = join(BUILD, 'generate')
  run(
    BUILD,
    'cmake',
    '-S',
    tdlib,
    '-B',
    generate,
    '-DTD_GENERATE_SOURCE_FILES=ON'
  )
  run(BUILD, 'cmake', '--build', generate, '-j', jobs)

  print('Building TDLib')
  let wasm = join(BUILD, 'wasm')
  run(
    BUILD,
    'emcmake',
    'cmake',
    '-S',
    tdlib,
    '-B',
    wasm,
    '-DCMAKE_BUILD_TYPE=MinSizeRel',
    '-DCMAKE_C_FLAGS_MINSIZEREL=-Oz -DNDEBUG',
    '-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG',
    // For a worker with Content-Security-Policy without `unsafe-eval`,
    // which loads the library as ES module and keeps its database in IndexedDB
    '-DCMAKE_EXE_LINKER_FLAGS=-sDYNAMIC_EXECUTION=0 -sENVIRONMENT=worker ' +
      '-sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=FS,cwrap,IDBFS',
    '-DOPENSSL_FOUND=1',
    `-DOPENSSL_ROOT_DIR=${openssl}`,
    `-DOPENSSL_INCLUDE_DIR=${openssl}/include`,
    `-DOPENSSL_CRYPTO_LIBRARY=${openssl}/libcrypto.a`,
    `-DOPENSSL_SSL_LIBRARY=${openssl}/libssl.a`,
    `-DOPENSSL_LIBRARIES=${openssl}/libssl.a;${openssl}/libcrypto.a`,
    `-DOPENSSL_VERSION=${lock.openssl.version}`
  )
  run(BUILD, 'cmake', '--build', wasm, '--target', 'td_wasm', '-j', jobs)

  rmSync(DIST, { force: true, recursive: true })
  mkdirSync(DIST)
  copyFileSync(join(wasm, 'td_wasm.js'), join(DIST, 'td_wasm.js'))
  copyFileSync(join(wasm, 'td_wasm.wasm'), join(DIST, 'td_wasm.wasm'))
  writeFileSync(join(DIST, 'tdlib.lock'), lockText)
  rmSync(BUILD, { force: true, recursive: true })
}

let built = join(DIST, 'tdlib.lock')
if (!existsSync(built) || readFileSync(built, 'utf8') !== lockText) {
  await download()
  build()
}
