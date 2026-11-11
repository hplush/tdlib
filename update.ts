// Move tdlib.lock and package.json to the latest TDLib version.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = import.meta.dirname

async function load(url: string): Promise<Response> {
  let response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} from ${url}`)
  return response
}

let commits = await load('https://api.github.com/repos/tdlib/td/commits/master')
let { sha } = (await commits.json()) as { sha: string }
let cmake = await load(
  `https://raw.githubusercontent.com/tdlib/td/${sha}/CMakeLists.txt`
)
let latest = /^project\(TDLib VERSION ([\d.]+)/m.exec(await cmake.text())?.[1]
if (!latest) throw new Error('No TDLib version in CMakeLists.txt')

let packagePath = join(ROOT, 'package.json')
let packageText = readFileSync(packagePath, 'utf8')
let current = (JSON.parse(packageText) as { version: string }).version

if (latest === current) {
  process.stdout.write(`TDLib ${current} is the latest version\n`)
} else {
  let archive = await load(`https://github.com/tdlib/td/archive/${sha}.tar.gz`)
  let lockPath = join(ROOT, 'tdlib.lock')
  let lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    tdlib: { commit: string; sha256: string }
  }
  lock.tdlib = {
    commit: sha,
    sha256: createHash('sha256')
      .update(Buffer.from(await archive.arrayBuffer()))
      .digest('hex')
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  writeFileSync(
    packagePath,
    packageText.replace(`"version": "${current}"`, `"version": "${latest}"`)
  )
  process.stdout.write(`Updated TDLib from ${current} to ${latest}\n`)
}
