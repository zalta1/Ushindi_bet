import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAdult, normalizeName, normalizeTzPhone, passwordProblem } from './identity.js'

test('normalizes Tanzanian mobile numbers', () => {
  assert.equal(normalizeTzPhone('+255712345678'), '+255712345678')
  assert.equal(normalizeTzPhone('255712345678'), '+255712345678')
  assert.equal(normalizeTzPhone('0712345678'), '+255712345678')
  assert.equal(normalizeTzPhone('712345678'), '+255712345678')
  assert.equal(normalizeTzPhone('+255 612 345 678'), '+255612345678')
  assert.equal(normalizeTzPhone('0512345678'), null)
  assert.equal(normalizeTzPhone('+254712345678'), null)
  assert.equal(normalizeTzPhone('07123'), null)
  assert.equal(normalizeTzPhone('not-a-phone'), null)
})

test('rejects underage dates of birth in Dar es Salaam', () => {
  assert.equal(isAdult('1990-01-01', new Date('2026-10-23T12:00:00Z')), true)
  assert.equal(isAdult('2008-10-23', new Date('2026-10-23T12:00:00Z')), true)
  assert.equal(isAdult('2008-10-24', new Date('2026-10-23T12:00:00Z')), false)
  assert.equal(isAdult('2010-01-01', new Date('2026-10-23T12:00:00Z')), false)
  assert.equal(isAdult('1990-02-31'), false)
})

test('password policy requires length, a letter, and a digit', () => {
  assert.equal(passwordProblem('Test12345!x', '+255712345678'), 'min_length')
  assert.equal(passwordProblem('short1', '+255712345678'), 'min_length')
  assert.equal(passwordProblem('abcdefghijkl', '+255712345678'), 'letter_and_digit')
  assert.equal(passwordProblem('123456789012', '+255712345678'), 'letter_and_digit')
  assert.equal(passwordProblem('local_dev_only_change_me_1', '+255712345678'), 'common')
  assert.equal(passwordProblem('Horse-battery-9', '+255712345678'), null)
  assert.equal(passwordProblem('includes712345678x', '+255712345678'), 'contains_phone')
  assert.equal(passwordProblem('local_dev_only_change_me_1', '+255712345678', true), null)
})

test('names are trimmed and must contain letters', () => {
  assert.equal(normalizeName('  Asha  Juma '), 'Asha Juma')
  assert.equal(normalizeName('A'), null)
  assert.equal(normalizeName('1234'), null)
})

test('production refuses the example admin password', async () => {
  const keys = ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'SUPER_ADMIN_PHONE', 'SUPER_ADMIN_PASSWORD', 'COOKIE_SECURE'] as const
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ushindi:x@127.0.0.1:5432/ushindi_test'
    process.env.REDIS_URL = 'redis://127.0.0.1:6379'
    process.env.SUPER_ADMIN_PHONE = '+255700000001'
    process.env.SUPER_ADMIN_PASSWORD = 'local_dev_only_change_me_1'
    process.env.COOKIE_SECURE = 'true'
    const { loadConfig } = await import('./config.js')
    assert.throws(() => loadConfig(), /example SUPER_ADMIN_PASSWORD/)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
