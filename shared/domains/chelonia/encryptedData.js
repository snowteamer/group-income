import sbp from '@sbp/sbp'
import type { Key } from './crypto.js'
import { decrypt, deserializeKey, encrypt, keyId, serializeKey } from './crypto.js'
import { ChelErrorDecryptionError, ChelErrorDecryptionKeyNotFound, ChelErrorUnexpected } from './errors.js'

// TODO: Check for permissions and allowedActions; this requires passing some
// additional context
const encryptData = function (eKeyId: string, data: any) {
  // Has the key been revoked? If so, attempt to find an authorized key by the same name
  // $FlowFixMe
  const designatedKey = this._vm?.authorizedKeys?.[eKeyId]
  if (!designatedKey?.purpose.includes(
    'enc'
  )) {
    throw new Error(`Encryption key ID ${eKeyId} is missing or is missing encryption purpose`)
  }
  if (designatedKey._notAfterHeight !== undefined) {
    const name = (this._vm: any).authorizedKeys[eKeyId].name
    const newKeyId = (Object.values(this._vm?.authorizedKeys).find((v: any) => designatedKey._notAfterHeight === undefined && v.name === name && v.purpose.includes('enc')): any)?.id

    if (!newKeyId) {
      throw new Error(`Encryption key ID ${eKeyId} has been revoked and no new key exists by the same name (${name})`)
    }

    eKeyId = newKeyId
  }

  const key = this._vm?.authorizedKeys?.[eKeyId].data

  if (!key) {
    throw new Error(`Missing encryption key ${eKeyId}`)
  }

  const deserializedKey = typeof key === 'string' ? deserializeKey(key) : key

  return JSON.stringify([
    keyId(deserializedKey),
    encrypt(deserializedKey, JSON.stringify(data))
  ])
}

// TODO: Check for permissions and allowedActions; this requires passing the
// entire GIMessage
const decryptData = function (height: number, data: string, additionalKeys: Object, validatorFn?: (v: any) => void) {
  if (!this) {
    throw new ChelErrorDecryptionError('Missing contract state')
  }

  const deserializedData = JSON.parse(data)

  if (!Array.isArray(deserializedData) || deserializedData.length !== 2 || deserializedData.map(v => typeof v).filter(v => v !== 'string').length !== 0) {
    throw new ChelErrorDecryptionError('Invalid message format')
  }

  const [eKeyId, message] = deserializedData
  // height as NaN is used to allow checking for revokedKeys as well as
  // authorizedKeys when decrypting data. This is normally inappropriate because
  // revoked keys should be considered compromised and not used for encrypting
  // new data
  // However, OP_KEY_SHARE may include data encrypted with some other contract's
  // keys when a key rotation is done. This is done, along with OP_ATOMIC and
  // OP_KEY_UPDATE to rotate keys in a contract while allowing member contracts
  // to retrieve and use the new key material.
  // In such scenarios, since the keys really live in that other contract, it is
  // impossible to know if the keys had been revoked in the 'source' contract
  // at the time the key rotation was done. This is also different from foreign
  // keys because these encryption keys are not necessarily authorized in the
  // contract issuing OP_KEY_SHARE, and what is important is to refer to the
  // (keys in the) foreign contract explicitly, as an alternative to sending
  // an OP_KEY_SHARE to that contract.
  // Using revoked keys represents some security risk since, as mentioned, they
  // should generlly be considered compromised. However, in the scenario above
  // we can trust that the party issuing OP_KEY_SHARE is not maliciously using
  // old (revoked) keys, because there is little to be gained from not doing
  // this. If that party's intention were to leak or compromise keys, they can
  // already do so by other means, since they have access to the raw secrets
  // that OP_KEY_SHARE is meant to protect. Hence, this attack does not open up
  // any new attack vectors or venues that were not already available using
  // different means.
  const designatedKey = this._vm?.authorizedKeys?.[eKeyId]

  if (!designatedKey || (height > designatedKey._notAfterHeight) || (height < designatedKey._notBeforeHeight) || !designatedKey.purpose.includes(
    'enc'
  )) {
    throw new ChelErrorUnexpected(
      `Key ${eKeyId} is unauthorized or expired for the current contract`
    )
  }

  const key = additionalKeys[eKeyId]

  if (!key) {
    throw new ChelErrorDecryptionKeyNotFound(`Key ${eKeyId} not found`)
  }

  const deserializedKey = typeof key === 'string' ? deserializeKey(key) : key

  try {
    const result = JSON.parse(decrypt(deserializedKey, message))
    if (typeof validatorFn === 'function') validatorFn(result)
    return result
  } catch (e) {
    throw new ChelErrorDecryptionError(e?.message || e)
  }
}

export const encryptedOutgoingData = (state: Object, eKeyId: string, data: any): Object => {
  const boundStringValueFn = encryptData.bind(state, eKeyId, data)

  const returnProps = {
    toJSON: boundStringValueFn,
    toString: boundStringValueFn,
    valueOf: () => data
  }

  return typeof data === 'object'
    ? Object.assign(Object.create(null), data, returnProps)
    : Object.assign(Object(data), returnProps)
}

// Used for OP_CONTRACT as a state does not yet exist
export const encryptedOutgoingDataWithRawKey = (key: Key, data: any): Object => {
  const eKeyId = keyId(key)
  const state = {
    _vm: {
      authorizedKeys: {
        [eKeyId]: {
          purpose: ['enc'],
          data: serializeKey(key, false),
          _notBeforeHeight: 0,
          _notAfterHeight: undefined
        }
      }
    }
  }
  const boundStringValueFn = encryptData.bind(state, eKeyId, data)

  const returnProps = {
    toJSON: boundStringValueFn,
    toString: boundStringValueFn,
    valueOf: () => data
  }

  return typeof data === 'object'
    ? Object.assign(Object.create(null), data, returnProps)
    : Object.assign(Object(data), returnProps)
}

export const encryptedIncomingData = (contractID: string, state: Object, data: string, height: number, additionalKeys?: Object, validatorFn?: (v: any) => void): Object => {
  const stringValueFn = () => data
  let decryptedValue
  const decryptedValueFn = () => {
    if (decryptedValue) {
      return decryptedValue
    }
    const rootState = sbp('chelonia/rootState')
    decryptedValue = decryptData.call(state || rootState?.[contractID], height, data, additionalKeys ?? rootState.secretKeys, validatorFn)
    return decryptedValue
  }

  return {
    toJSON: stringValueFn,
    toString: stringValueFn,
    valueOf: decryptedValueFn
  }
}

export const encryptedIncomingForeignData = (contractID: string, _0: any, data: string, _1: any, additionalKeys?: Object, validatorFn?: (v: any) => void): Object => {
  const stringValueFn = () => data
  let decryptedValue
  const decryptedValueFn = () => {
    if (decryptedValue) {
      return decryptedValue
    }
    const rootState = sbp('chelonia/rootState')
    decryptedValue = decryptData.call(rootState?.[contractID], NaN, data, additionalKeys ?? rootState.secretKeys, validatorFn)
    return decryptedValue
  }

  return {
    toJSON: stringValueFn,
    toString: stringValueFn,
    valueOf: decryptedValueFn
  }
}

export const encryptedDataKeyId = (data: string): string => {
  const deserializedData = JSON.parse(data)

  if (!Array.isArray(deserializedData) || deserializedData.length !== 2 || deserializedData.map(v => typeof v).filter(v => v !== 'string').length !== 0) {
    throw new ChelErrorDecryptionError('Invalid message format')
  }

  return deserializedData[0]
}
