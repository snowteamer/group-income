import { blake32Hash } from '~/shared/functions.ts'

export class GIMessage {
  static OP_CONTRACT = 'c'
  static OP_ACTION_ENCRYPTED: 'ae' = 'ae' // e2e-encrypted action
  static OP_ACTION_UNENCRYPTED: 'au' = 'au' // publicly readable action
  static OP_KEY_ADD = 'ka' // add this key to the list of keys allowed to write to this contract, or update an existing key
  static OP_KEY_DEL = 'kd' // remove this key from authorized keys
  static OP_PROTOCOL_UPGRADE = 'pu'
  static OP_PROP_SET = 'ps' // set a public key/value pair
  static OP_PROP_DEL = 'pd' // delete a public key/value pair

  // eslint-disable-next-line camelcase
  static createV1_0 (
    contractID = null,
    previousHEAD = null,
    op,
    signatureFn = defaultSignatureFn
  ) {
    const message = {
      version: '1.0.0',
      previousHEAD,
      contractID,
      op,
      // the nonce makes it difficult to predict message contents
      // and makes it easier to prevent conflicts during development
      nonce: Math.random()
    }
    // NOTE: the JSON strings generated here must be preserved forever.
    //       do not ever regenerate this message using the contructor.
    //       instead store it using serialize() and restore it using
    //       deserialize().
    const messageJSON = JSON.stringify(message)
    const value = JSON.stringify({
      message: messageJSON,
      sig: signatureFn(messageJSON)
    })
    return new this({
      mapping: { key: blake32Hash(value), value },
      message
    })
  }

  // TODO: we need signature verification upon decryption somewhere...
  static deserialize (value: string): this {
    if (!value) throw new Error(`deserialize bad value: ${value}`)
    return new this({
      mapping: { key: blake32Hash(value), value },
      message: JSON.parse(JSON.parse(value).message)
    })
  }

  constructor ({ mapping, message }: { mapping: Object, message: Object }) {
    this._mapping = mapping
    this._message = message
    // perform basic sanity check
    const [type] = this.message().op
    switch (type) {
      case GIMessage.OP_CONTRACT:
        if (!this.isFirstMessage()) throw new Error('OP_CONTRACT: must be first message')
        break
      case GIMessage.OP_ACTION_ENCRYPTED:
        // nothing for now
        break
      default:
        throw new Error(`unsupported op: ${type}`)
    }
  }

  decryptedValue (fn?: Function): any {
    if (!this._decrypted) {
      this._decrypted = (
        this.opType() === GIMessage.OP_ACTION_ENCRYPTED && fn !== undefined
          ? fn(this.opValue())
          : this.opValue()
      )
    }
    return this._decrypted
  }

  message () { return this._message }

  op () { return this.message().op }

  opType () { return this.op()[0] }

  opValue () { return this.op()[1] }

  description (): string {
    const type = this.opType()
    let desc = `<op_${type}`
    if (type === GIMessage.OP_ACTION_ENCRYPTED && this._decrypted) {
      const { _decrypted } = this
      if (typeof _decrypted.type === 'string') {
        desc += `|${_decrypted.type}`
      }
    } else if (type === GIMessage.OP_ACTION_UNENCRYPTED) {
      const value = this.opValue()
      if (typeof value.type === 'string') {
        desc += `|${value.type}`
      }
    }
    return `${desc}|${this.hash()} of ${this.contractID()}>`
  }

  isFirstMessage (): boolean { return !this.message().previousHEAD }

  contractID (): string { return this.message().contractID || this.hash() }

  serialize (): string { return this._mapping.value }

  hash (): string { return this._mapping.key }
}

function defaultSignatureFn (data: string) {
  return {
    type: 'default',
    sig: blake32Hash(data)
  }
}
