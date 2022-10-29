import {
  assert,
  assertEquals
} from 'asserts'

import '~/scripts/process-shim.ts'

import { createClient } from './pubsub.ts'

const client = createClient('ws://localhost:8080', {
  manual: true,
  reconnectOnDisconnection: false,
  reconnectOnOnline: false,
  reconnectOnTimeout: false
})
const {
  maxReconnectionDelay,
  minReconnectionDelay
} = client.options

const createRandomDelays = (number: number) => {
  return [...new Array(number)].map((_, i) => {
    client.failedConnectionAttempts = i
    return client.getNextRandomDelay()
  })
}
const delays1 = createRandomDelays(10)
const delays2 = createRandomDelays(10)

// Test steps must be async, but we don't always use `await` in them.
/* eslint-disable require-await */
Deno.test({
  name: 'Test getNextRandomDelay()',
  fn: async function (tests) {
    await tests.step('every delay should be longer than the previous one', async function () {
      // In other words, the delays should be sorted in ascending numerical order.
      assertEquals(delays1, [...delays1].sort((a, b) => a - b))
      assertEquals(delays2, [...delays2].sort((a, b) => a - b))
    })

    await tests.step('no delay should be shorter than the minimal reconnection delay', async function () {
      delays1.forEach((delay) => {
        assert(delay >= minReconnectionDelay)
      })
      delays2.forEach((delay) => {
        assert(delay >= minReconnectionDelay)
      })
    })

    await tests.step('no delay should be longer than the maximal reconnection delay', async function () {
      delays1.forEach((delay) => {
        assert(delay <= maxReconnectionDelay)
      })
      delays2.forEach((delay) => {
        assert(delay <= maxReconnectionDelay)
      })
    })
  },
  sanitizeResources: false,
  sanitizeOps: false
})
