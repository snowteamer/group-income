import sbp from '@sbp/sbp'
import '@sbp/okturtles.data'
import { GIMessage } from './GIMessage.ts'
import { ChelErrorDBBadPreviousHEAD, ChelErrorDBConnection } from './errors.ts'

const headSuffix = '-HEAD'

// NOTE: To enable persistence of log use 'sbp/selectors/overwrite'
//       to overwrite the following selectors:
sbp('sbp/selectors/unsafe', ['chelonia/db/get', 'chelonia/db/set', 'chelonia/db/delete'])
// NOTE: MAKE SURE TO CALL 'sbp/selectors/lock' after overwriting them!

const dbPrimitiveSelectors = Deno.env.get('LIGHTWEIGHT_CLIENT') === 'true'
  ? {
      'chelonia/db/get': function (key) {
        const id = sbp('chelonia/db/contractIdFromLogHEAD', key)
        return Promise.resolve(id ? sbp(this.config.stateSelector).contracts[id]?.HEAD : null)
      },
      'chelonia/db/set': function (key, value) { return Promise.resolve(value) },
      'chelonia/db/delete': function () { return Promise.resolve() }
    }
  : {
      'chelonia/db/get': function (key: string) {
        return Promise.resolve(sbp('okTurtles.data/get', key))
      },
      'chelonia/db/set': function (key: string, value: string) {
        return Promise.resolve(sbp('okTurtles.data/set', key, value))
      },
      'chelonia/db/delete': function (key: string) {
        return Promise.resolve(sbp('okTurtles.data/delete', key))
      }
    }

export default (sbp('sbp/selectors/register', {
  ...dbPrimitiveSelectors,
  'chelonia/db/logHEAD': function (contractID: string): string {
    return `${contractID}${headSuffix}`
  },
  'chelonia/db/contractIdFromLogHEAD': function (key: string) {
    return key.endsWith(headSuffix) ? key.slice(0, -headSuffix.length) : null
  },
  'chelonia/db/latestHash': function (contractID: string) {
    return sbp('chelonia/db/get', sbp('chelonia/db/logHEAD', contractID))
  },
  'chelonia/db/getEntry': async function (hash: string) {
    try {
      const value: string = await sbp('chelonia/db/get', hash)
      if (!value) throw new Error(`no entry for ${hash}!`)
      return GIMessage.deserialize(value)
    } catch (e) {
      throw new ChelErrorDBConnection(`${e.name} during getEntry: ${e.message}`)
    }
  },
  'chelonia/db/addEntry': async function (entry: GIMessage) {
    try {
      const { previousHEAD } = entry.message()
      const contractID: string = entry.contractID()
      if (await sbp('chelonia/db/get', entry.hash())) {
        console.warn(`[chelonia.db] entry exists: ${entry.hash()}`)
        return entry.hash()
      }
      const HEAD = await sbp('chelonia/db/latestHash', contractID)
      if (!entry.isFirstMessage() && previousHEAD !== HEAD) {
        console.error(`[chelonia.db] bad previousHEAD: ${previousHEAD}! Expected: ${HEAD} for contractID: ${contractID}`)
        throw new ChelErrorDBBadPreviousHEAD(`bad previousHEAD: ${previousHEAD}`)
      }
      await sbp('chelonia/db/set', entry.hash(), entry.serialize())
      await sbp('chelonia/db/set', sbp('chelonia/db/logHEAD', contractID), entry.hash())
      console.debug(`[chelonia.db] HEAD for ${contractID} updated to:`, entry.hash())
      return entry.hash()
    } catch (e) {
      if (e.name.includes('ErrorDB')) {
        throw e // throw the specific type of ErrorDB instance
      }
      throw new ChelErrorDBConnection(`${e.name} during addEntry: ${e.message}`)
    }
  },
  'chelonia/db/lastEntry': async function (contractID: string) {
    try {
      const hash = await sbp('chelonia/db/latestHash', contractID)
      if (!hash) throw new Error(`contract ${contractID} has no latest hash!`)
      return sbp('chelonia/db/getEntry', hash)
    } catch (e) {
      throw new ChelErrorDBConnection(`${e.name} during lastEntry: ${e.message}`)
    }
  }
}))
