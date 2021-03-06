/* eslint-env node, browser, jasmine */
const { makeFixture } = require('./__helpers__/FixtureFS.js')
const pify = require('pify')
const path = require('path')

const { plugins, init, add, commit } = require('isomorphic-git')

describe('basic test', () => {
  it('does not explode', async () => {
    let { fs, dir } = await makeFixture('test-basic')
    plugins.set('fs', fs)
    console.log('Loaded fs')
    await init({ dir })
    console.log('init')

    await pify(fs.writeFile)(path.join(dir, 'a.txt'), 'Hello')
    await add({ dir, filepath: 'a.txt' })
    console.log('add a.txt')

    let oid = await commit({
      dir,
      author: {
        name: 'Mr. Test',
        email: 'mrtest@example.com',
        timestamp: 1262356920,
        timezoneOffset: -0
      },
      message: 'Initial commit'
    })
    console.log('commit')

    expect(oid).toEqual('066daf8b7c79dca893d91ce0577dfab5ace80dbc')
    console.log('checked oid')
  })
})
