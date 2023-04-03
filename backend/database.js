'use strict'

import sbp from '@sbp/sbp'
import { strToB64 } from '~/shared/functions.js'
import { Readable } from 'stream'
import fs from 'fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import '@sbp/okturtles.data'
import '~/shared/domains/chelonia/db.js'
import LRU from 'lru-cache'

const Boom = require('@hapi/boom')

const production = process.env.NODE_ENV === 'production'
// Defaults to `fs` in production.
const persistence = process.env.GI_PERSIST || (production ? 'fs' : undefined)

// Default database options. Other values may be used e.g. in tests.
const options = {
  fs: {
    dirname: './data'
  },
  sqlite: {
    dirname: './data',
    filename: 'groupincome.db'
  }
}

// Used by `throwIfFileOutsideDataDir()`.
const dataFolder = path.resolve(options.fs.dirname)

// Create our data folder if it doesn't exist yet.
// This is currently necessary even when not using persistence, e.g. to store file uploads.
if (!fs.existsSync(dataFolder)) {
  fs.mkdirSync(dataFolder, { mode: 0o750 })
}

sbp('sbp/selectors/register', {
  'backend/db/streamEntriesSince': async function (contractID: string, hash: string): Promise<*> {
    let currentHEAD = await sbp('chelonia/db/latestHash', contractID)
    if (!currentHEAD) {
      throw Boom.notFound(`contractID ${contractID} doesn't exist!`)
    }
    let prefix = '['
    // NOTE: if this ever stops working you can also try Readable.from():
    // https://nodejs.org/api/stream.html#stream_stream_readable_from_iterable_options
    return new Readable({
      async read (): any {
        try {
          const entry = await sbp('chelonia/db/getEntry', currentHEAD)
          const json = `"${strToB64(entry.serialize())}"`
          if (currentHEAD !== hash) {
            this.push(prefix + json)
            currentHEAD = entry.message().previousHEAD
            prefix = ','
          } else {
            this.push(prefix + json + ']')
            this.push(null)
          }
        } catch (e) {
          console.error(`read(): ${e.message}:`, e)
          this.push(']')
          this.push(null)
        }
      }
    })
  },
  'backend/db/streamEntriesBefore': async function (before: string, limit: number): Promise<*> {
    let prefix = '['
    let currentHEAD = before
    let entry = await sbp('chelonia/db/getEntry', currentHEAD)
    if (!entry) {
      throw Boom.notFound(`entry ${currentHEAD} doesn't exist!`)
    }
    limit++ // to return `before` apart from the `limit` number of events
    // NOTE: if this ever stops working you can also try Readable.from():
    // https://nodejs.org/api/stream.html#stream_stream_readable_from_iterable_options
    return new Readable({
      async read (): any {
        try {
          if (!currentHEAD || !limit) {
            this.push(']')
            this.push(null)
          } else {
            entry = await sbp('chelonia/db/getEntry', currentHEAD)
            const json = `"${strToB64(entry.serialize())}"`
            this.push(prefix + json)
            prefix = ','
            limit--
            currentHEAD = entry.message().previousHEAD
          }
        } catch (e) {
          // TODO: properly return an error to caller, see https://nodejs.org/api/stream.html#errors-while-reading
          console.error(`read(): ${e.message}:`, e)
          this.push(']')
          this.push(null)
        }
      }
    })
  },
  'backend/db/streamEntriesBetween': async function (startHash: string, endHash: string, offset: number): Promise<*> {
    let prefix = '['
    let isMet = false
    let currentHEAD = endHash
    let entry = await sbp('chelonia/db/getEntry', currentHEAD)
    if (!entry) {
      throw Boom.notFound(`entry ${currentHEAD} doesn't exist!`)
    }
    // NOTE: if this ever stops working you can also try Readable.from():
    // https://nodejs.org/api/stream.html#stream_stream_readable_from_iterable_options
    return new Readable({
      async read (): any {
        try {
          entry = await sbp('chelonia/db/getEntry', currentHEAD)
          const json = `"${strToB64(entry.serialize())}"`
          this.push(prefix + json)
          prefix = ','

          if (currentHEAD === startHash) {
            isMet = true
          } else if (isMet) {
            offset--
          }

          currentHEAD = entry.message().previousHEAD
          if (!currentHEAD || (isMet && !offset)) {
            this.push(']')
            this.push(null)
          }
        } catch (e) {
          // TODO: properly return an error to caller, see https://nodejs.org/api/stream.html#errors-while-reading
          console.error(`read(): ${e.message}:`, e)
          this.push(']')
          this.push(null)
        }
      }
    })
  },
  // =======================
  // wrapper methods to add / lookup names
  // =======================
  'backend/db/registerName': async function (name: string, value: string): Promise<*> {
    const exists = await sbp('backend/db/lookupName', name)
    if (exists) {
      if (!Boom.isBoom(exists)) {
        return Boom.conflict('exists')
      } else if (exists.output.statusCode !== 404) {
        throw exists // throw if this is an error other than "not found"
      }
      // otherwise it is a Boom.notFound(), proceed ahead
    }
    await sbp('chelonia/db/set', namespaceKey(name), value)
    return { name, value }
  },
  'backend/db/lookupName': async function (name: string): Promise<string | Error> {
    const value = await sbp('chelonia/db/get', namespaceKey(name))
    return value || Boom.notFound()
  },
  // =======================
  // Filesystem API
  //
  // TODO: add encryption
  // =======================
  'backend/db/readFile': async function (filename: string): Promise<Buffer | Error> {
    const filepath = throwIfFileOutsideDataDir(filename)
    if (!fs.existsSync(filepath)) {
      return Boom.notFound()
    }
    return await readFile(filepath)
  },
  'backend/db/writeFile': async function (filename: string, data: any): Promise<void> {
    // TODO: check for how much space we have, and have a server setting
    //       that determines how much of the disk space we're allowed to
    //       use. If the size of the file would cause us to exceed this
    //       amount, throw an exception
    return await writeFile(throwIfFileOutsideDataDir(filename), data)
  },
  'backend/db/writeFileOnce': async function (filename: string, data: any): Promise<void> {
    const filepath = throwIfFileOutsideDataDir(filename)
    if (fs.existsSync(filepath)) {
      console.warn('writeFileOnce: exists:', filepath)
      return
    }
    return await writeFile(filepath, data)
  }
})

export function checkKey (key: string): void {
  if (/[/\\]/.test(key)) {
    throw Boom.badRequest(`bad name: ${key}`)
  }
}

function namespaceKey (name: string): string {
  return 'name=' + name
}

// Used to thwart path traversal attacks.
function throwIfFileOutsideDataDir (filename: string): string {
  const filepath = path.resolve(path.join(dataFolder, filename))
  if (filepath.indexOf(dataFolder) !== 0) {
    throw Boom.badRequest(`bad name: ${filename}`)
  }
  return filepath
}

export default async () => {
  // If persistence must be enabled:
  // - load and initialize the selected storage backend
  // - register `readString` and `writeString` selectors
  // - overwrite 'chelonia/db/get' and '-set' to use an LRU cache
  if (persistence) {
    const { initStorage, readString, writeString } = await import(`./${persistence}-backend.js`)

    await initStorage(options[persistence])
    sbp('sbp/selectors/register', {
      'backend/db/readString': readString,
      'backend/db/writeString': writeString
    })

    // https://github.com/isaacs/node-lru-cache#usage
    const cache = new LRU({
      max: Number(process.env.GI_LRU_NUM_ITEMS) || 10000
    })

    sbp('sbp/selectors/overwrite', {
      'chelonia/db/get': async function (key: string): Promise<string | void> {
        const lookupValue = cache.get(key)
        if (lookupValue !== undefined) {
          return lookupValue
        }
        const value = await sbp('backend/db/readString', key)
        if (value !== undefined) {
          cache.set(key, value)
        }
        return value
      },
      'chelonia/db/set': async function (key: string, value: string): Promise<void> {
        await sbp('backend/db/writeString', key, value)
        cache.set(key, value)
      }
    })
    sbp('sbp/selectors/lock', ['chelonia/db/get', 'chelonia/db/set', 'chelonia/db/delete'])
  }
}
