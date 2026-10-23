import argon2 from 'argon2'

const options: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
}

let dummyHash: string | null = null

export async function warmPasswordHasher(): Promise<void> {
  if (!dummyHash) dummyHash = await argon2.hash('ushindi-dummy-password-not-a-secret', options)
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, options)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

/** Spend the same work as a real verify when the account does not exist. */
export async function dummyVerify(password: string): Promise<void> {
  await warmPasswordHasher()
  if (dummyHash) await verifyPassword(dummyHash, password)
}
