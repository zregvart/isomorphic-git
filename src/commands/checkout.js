import path from 'path'

import { GitIndexManager } from '../managers/GitIndexManager.js'
import { GitRefManager } from '../managers/GitRefManager.js'
import { FileSystem } from '../models/FileSystem.js'
import { E, GitError } from '../models/GitError.js'
import { WORKDIR } from '../models/GitWalkerIndex.js'
import { STAGE } from '../models/GitWalkerRepo.js'
import { TREE } from '../models/GitWalkerRepo.js'
import { readObject } from '../storage/readObject'
import { cores } from '../utils/plugins.js'

import { config } from './config'
import { currentBranch } from './currentBranch.js'
import { walkBeta1 } from './walkBeta1.js'

/**
 * Checkout a branch
 *
 * @link https://isomorphic-git.github.io/docs/checkout.html
 */
export async function checkout ({
  core = 'default',
  dir,
  gitdir = path.join(dir, '.git'),
  fs: _fs = cores.get(core).get('fs'),
  remote = 'origin',
  ref
}) {
  try {
    const fs = new FileSystem(_fs)
    if (ref === undefined) {
      throw new GitError(E.MissingRequiredParameterError, {
        function: 'checkout',
        parameter: 'ref'
      })
    }
    // Get tree oid
    let oid
    try {
      oid = await GitRefManager.resolve({ fs, gitdir, ref })
      // TODO: Figure out what to do if both 'ref' and 'remote' are specified, ref already exists,
      // and is configured to track a different remote.
    } catch (err) {
      // If `ref` doesn't exist, create a new remote tracking branch
      // Figure out the commit to checkout
      let remoteRef = `${remote}/${ref}`
      oid = await GitRefManager.resolve({
        fs,
        gitdir,
        ref: remoteRef
      })
      // Set up remote tracking branch
      await config({
        gitdir,
        fs,
        path: `branch.${ref}.remote`,
        value: `${remote}`
      })
      await config({
        gitdir,
        fs,
        path: `branch.${ref}.merge`,
        value: `refs/heads/${ref}`
      })
      // Create a new branch that points at that same commit
      await fs.write(`${gitdir}/refs/heads/${ref}`, oid + '\n')
    }
    let fullRef = await GitRefManager.expand({ fs, gitdir, ref })

    let currentRef = await currentBranch({ dir, gitdir, fs, fullname: true })

    // Note: at some point we'll get to re-use this algorithm for computing merges!
    // Figure out what we need to do.
    let operations = []
    let errors = []
    await walkBeta1({
      fs,
      dir,
      gitdir,
      trees: [
        WORKDIR({ fs, dir, gitdir }),
        STAGE({ fs, gitdir }),
        TREE({ fs, gitdir, ref: currentRef }),
        TREE({ fs, gitdir, ref }),
      ],
      map: async function ([workdir, stage, head, next]) {
        if (workdir.fullpath === '.') return
        // Case: file is untracked
        if (!head.exists && !next.exists) {
          // Do nothing
          return
        }
        await next.populateStat()
        // For now, just ignore directories
        // TODO: Handle all the edge cases with directories becoming files and vice versa
        if (next.type === 'tree') return
        // For now, just skip over submodules
        if (next.type === 'commit') {
          // gitlinks
          console.log(
            new GitError(E.NotImplementedFail, { thing: 'submodule support' })
          )
          return
        }
        // Case: file got deleted
        if (head.exists && !next.exists) {
          // If we also deleted it, no change is necessary.
          if (!workdir.exists) {
            // Do nothing
          } else {
            // Otherwise, make sure it is safe to delete the file
            await workdir.populateHash()
            await head.populateHash()
            if (workdir.oid === head.oid) {
              operations.push({
                op: 'unlink',
                filepath: workdir.fullpath
              })
            } else {
              errors.push(new GitError(E.InternalFail, {
                message: `Your file ${workdir.fullpath} has local changes but has been deleted in ${ref}. Commit or stash your changes before checking out ${ref}.`
              })
            }
          }
          return
        }
        // Case: file got added
        if (!head.exists && next.exists) {
          // If it's not present in the working directory, we can safely add it
          if (!workdir.exists) {
            await next.populateStat()
            await next.populateHash()
            operations.push({
              op: 'write',
              filepath: workdir.fullpath,
              oid: next.oid,
              mode: next.mode
            })
          } else {
            // We have already added this file... make sure it's identical
            await workdir.populateHash()
            await next.populateHash()
            if (workdir.oid === next.oid) {
              // Do nothing
            } else {
              errors.push(new GitError(E.InternalFail, {
                message: `You added file ${workdir.fullpath} but a different file with the same name was added in ${ref}. Commit or stash your changes before checking out ${ref}.`
              })
            }
          }
          return
        }
        // Case: file continues to exist
        if (head.exists && next.exists) {
          // Did the file change?
          await head.populateHash()
          await next.populateHash()
          if (head.oid === next.oid) {
            // File didn't change
            // Do nothing
          } else {
            // File got changed
            await workdir.populateHash()
            if (workdir.oid === next.oid) {
              // We've already made the change locally.
              // Do nothing
            } else if (workdir.oid === head.oid) {
              // We haven't modified the file so it is safe to overwrite
              await next.populateStat()
              operations.push({
                op: 'write',
                filepath: workdir.fullpath,
                oid: next.oid,
                mode: next.mode
              })
            } else {
              errors.push(new GitError(E.InternalFail, {
                message: `Your file ${workdir.fullpath} has local changes but has been changed in ${ref}. Commit or stash your changes before checking out ${ref}.`
              })
            }
          }
          return
        }
      }
    })

    console.log('operations', operations)
    console.log('errors', errors)

    // Abort if it's not safe
    if (errors.length > 0) {
      return errors
    }

    
    // Do it.
    // Acquire a lock on the index
    await GitIndexManager.acquire(
      { fs, filepath: `${gitdir}/index` },
      async function (index) {
        // Do all deletions first, followed by writes
        for (let op of operations) {
          if (op.op === 'unlink') {
            try {
              await fs.rm(`${dir}/${op.filepath}`)
            } catch (err) {}
          }
        }
        for (let op of operations) {
          if (op.op === 'write') {
            let { type, object } = readObject({ fs, gitdir, oid: op.oid })
            if (type !== 'blob') {
              throw new GitError(E.ObjectTypeAssertionInTreeFail, {
                type,
                oid: op.oid,
                entrypath: op.fullpath
              })
            }
            switch (op.mode) {
              case '100644': {
                // regular file
                await fs.write(filepath, object)
                break
              }
              case '---CONTINUE HERE---'
            }
          }
        }
        // TODO: Big optimization possible here.
        // Instead of deleting and rewriting everything, only delete files
        // that are not present in the new branch, and only write files that
        // are not in the index or are in the index but have the wrong SHA.
        for (let entry of index) {
          try {
            await fs.rm(path.join(dir, entry.path))
          } catch (err) {}
        }
        index.clear()
        try {
          await walkBeta1({
            fs,
            dir,
            gitdir,
            trees: [TREE({ fs, gitdir, ref }), WORKDIR({ fs, dir, gitdir })],
            map: async function ([head, workdir]) {
              if (head.fullpath === '.') return
              if (!head.exists) return
              await head.populateStat()
              const filepath = `${dir}/${head.fullpath}`
              switch (head.type) {
                case 'tree': {
                  // ignore directories for now
                  if (!workdir.exists) await fs.mkdir(filepath)
                  break
                }
                case 'commit': {
                  // gitlinks
                  console.log(
                    new GitError(E.NotImplementedFail, {
                      thing: 'submodule support'
                    })
                  )
                  break
                }
                case 'blob': {
                  await head.populateContent()
                  await head.populateHash()
                  if (head.mode === '100644') {
                    // regular file
                    await fs.write(filepath, head.content)
                  } else if (head.mode === '100755') {
                    // executable file
                    await fs.write(filepath, head.content, { mode: 0o755 })
                  } else if (head.mode === '120000') {
                    // symlink
                    await fs.writelink(filepath, head.content)
                  } else {
                    throw new GitError(E.InternalFail, {
                      message: `Invalid mode "${head.mode}" detected in blob ${
                        head.oid
                      }`
                    })
                  }
                  let stats = await fs.lstat(filepath)
                  // We can't trust the executable bit returned by lstat on Windows,
                  // so we need to preserve this value from the TREE.
                  // TODO: Figure out how git handles this internally.
                  if (head.mode === '100755') {
                    stats.mode = 0o755
                  }
                  index.insert({
                    filepath: head.fullpath,
                    stats,
                    oid: head.oid
                  })
                  break
                }
                default: {
                  throw new GitError(E.ObjectTypeAssertionInTreeFail, {
                    type: head.type,
                    oid: head.oid,
                    entrypath: head.fullpath
                  })
                }
              }
            }
          })
        } catch (err) {
          // Throw a more helpful error message for this common mistake.
          if (err.code === E.ReadObjectFail && err.data.oid === oid) {
            throw new GitError(E.CommitNotFetchedError, { ref, oid })
          } else {
            throw err
          }
        }
        // Update HEAD TODO: Handle non-branch cases
        await fs.write(`${gitdir}/HEAD`, `ref: ${fullRef}`)
      }
    )
  } catch (err) {
    err.caller = 'git.checkout'
    throw err
  }
}
