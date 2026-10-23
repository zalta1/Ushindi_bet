// Read before the libuv thread pool starts. Argon2 uses that pool, and a
// real-money login burst will stall if only the default 4 threads are available.
const current = Number(process.env.UV_THREADPOOL_SIZE ?? 4)
if (!Number.isFinite(current) || current < 8) {
  process.env.UV_THREADPOOL_SIZE = '8'
}
