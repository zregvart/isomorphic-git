import path from 'path'

import { GitRefManager } from '../managers/GitRefManager.js'
import { FileSystem } from '../models/FileSystem.js'
import { cores } from '../utils/plugins.js'

/**
 * Get the name of the branch currently pointed to by .git/HEAD
 *
 * @link https://isomorphic-git.github.io/docs/currentBranch.html
 */
export async function currentBranch ({
  core = 'default',
  dir,
  gitdir = path.join(dir, '.git'),
  fs: _fs = cores.get(core).get('fs'),
  fullname = false
}) {
  try {
    const fs = new FileSystem(_fs)
    let ref = await GitRefManager.resolve({
      fs,
      gitdir,
      ref: 'HEAD',
      depth: 2
    })
    if (fullname) return ref
    return GitRefManager.abbrev({
      fs,
      gitdir,
      ref
    })
  } catch (err) {
    err.caller = 'git.currentBranch'
    throw err
  }
}
