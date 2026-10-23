import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { ApiError } from '../errors.js'
import { normalizeTzPhone } from '../identity.js'
import { operatorConfig } from '../operator-config.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'

export function registerDepositRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/deposits/limits', async () => ({
    minDeposit: operatorConfig.minDeposit,
    maxDeposit: operatorConfig.maxDeposit,
    currency: 'TZS',
  }))

  app.post(
    '/api/deposits',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'phone'],
          properties: {
            amount: { type: 'integer', minimum: 1, maximum: 100_000_000 },
            phone: { type: 'string', minLength: 1, maxLength: 32 },
          },
        },
      },
    },
    async (req, reply) => {
      assertOrigin(req, cfg.corsOrigins)
      if (!req.auth) throw new ApiError(401, 'unauthenticated')
      assertCsrf(req, req.auth.csrfHash)
      const body = req.body as { amount: number; phone: string }
      const fields: Record<string, string> = {}
      const phone = normalizeTzPhone(body.phone)
      if (!phone) fields.phone = 'invalid_phone'
      if (body.amount < operatorConfig.minDeposit) fields.amount = 'min_deposit'
      else if (body.amount > operatorConfig.maxDeposit) fields.amount = 'max_deposit'
      if (Object.keys(fields).length || !phone) {
        const onlyAmount = fields.amount && !fields.phone
        const code = onlyAmount && fields.amount === 'min_deposit'
          ? 'amount_below_minimum'
          : onlyAmount && fields.amount === 'max_deposit'
            ? 'amount_above_maximum'
            : fields.phone && !fields.amount
              ? 'invalid_phone'
              : 'validation'
        throw new ApiError(400, code, {
          fields,
          minDeposit: operatorConfig.minDeposit,
          maxDeposit: operatorConfig.maxDeposit,
        })
      }

      const { rows } = await getPool(cfg).query<{ id: string }>(
        `INSERT INTO deposit_requests (user_id, phone, amount_tzs, status, provider)
         VALUES ($1, $2, $3, 'pending', 'sandbox')
         RETURNING id`,
        [req.auth.userId, phone, body.amount],
      )
      reply.code(201)
      return {
        id: rows[0].id,
        status: 'pending',
        amountTzs: body.amount,
        phone,
        currency: 'TZS',
        sandbox: true,
        ledger: false,
      }
    },
  )
}
