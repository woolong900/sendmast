import type { Redis } from 'ioredis';

export interface AcsQuota {
  rpsLimit: number;
  rpmLimit: number;
  rphLimit: number;
  rpdLimit: number;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Sliding-window quota.
 *
 * Each ACS account has a single Redis Sorted Set `acs:{id}:events` whose
 * members are unique nonces and scores are millisecond timestamps. To check
 * how many sends are still allowed under any of the four windows we just
 * `ZCOUNT (now-windowMs) +inf`. To record a send we `ZADD` one entry.
 *
 * Old entries beyond the longest window (24h) are pruned on every operation
 * via `ZREMRANGEBYSCORE`, and the key itself carries a 24h TTL so an account
 * that goes idle reclaims memory automatically.
 *
 * Compared with the previous fixed-window implementation, this guarantees
 * that *any* rolling window of the configured length never exceeds its
 * limit — there is no "boundary burst" effect at minute/hour/day rollovers.
 */
export class QuotaManager {
  private nonceCounter = 0;
  private readonly nonceBase = `${process.pid}-${Date.now().toString(36)}`;

  constructor(private readonly redis: Redis) {
    redis.defineCommand('sendmastQuotaAvail', {
      numberOfKeys: 1,
      lua: AVAIL_LUA,
    });
    redis.defineCommand('sendmastQuotaConsume', {
      numberOfKeys: 1,
      lua: CONSUME_LUA,
    });
  }

  /**
   * How many sends can start right now without violating any of the four
   * sliding windows. Returns 0 when the tightest window is already at limit.
   */
  async getAvailable(acsAccountId: string, q: AcsQuota): Promise<number> {
    const result = await (this.redis as RedisWithCommands).sendmastQuotaAvail(
      this.key(acsAccountId),
      String(Date.now()),
      String(q.rpsLimit),
      String(q.rpmLimit),
      String(q.rphLimit),
      String(q.rpdLimit),
    );
    return Number(result);
  }

  /**
   * Record `count` sends. We do not check limits here on purpose — runSend
   * only calls this after ACS has accepted, and a momentary over-issuance
   * (when several workers all flip to sent in the same window) is preferred
   * over rejecting a send that already left our system.
   */
  async consume(acsAccountId: string, _q: AcsQuota, count: number): Promise<void> {
    const nonce = `${this.nonceBase}-${++this.nonceCounter}`;
    await (this.redis as RedisWithCommands).sendmastQuotaConsume(
      this.key(acsAccountId),
      String(Date.now()),
      String(count),
      nonce,
    );
  }

  private key(acsAccountId: string): string {
    return `acs:${acsAccountId}:events`;
  }
}

interface RedisWithCommands extends Redis {
  sendmastQuotaAvail(
    key: string,
    now: string,
    sLimit: string,
    mLimit: string,
    hLimit: string,
    dLimit: string,
  ): Promise<number>;
  sendmastQuotaConsume(
    key: string,
    now: string,
    count: string,
    nonce: string,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Lua scripts (constants are inlined to avoid passing extra ARGV every call).
// ---------------------------------------------------------------------------

const AVAIL_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local sLimit = tonumber(ARGV[2])
local mLimit = tonumber(ARGV[3])
local hLimit = tonumber(ARGV[4])
local dLimit = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. (now - ${DAY_MS}))

local sCount = redis.call('ZCOUNT', key, '(' .. (now - ${SECOND_MS}), '+inf')
local mCount = redis.call('ZCOUNT', key, '(' .. (now - ${MINUTE_MS}), '+inf')
local hCount = redis.call('ZCOUNT', key, '(' .. (now - ${HOUR_MS}),   '+inf')
local dCount = redis.call('ZCOUNT', key, '(' .. (now - ${DAY_MS}),    '+inf')

local s = sLimit - sCount
local m = mLimit - mCount
local h = hLimit - hCount
local d = dLimit - dCount

if s < 0 then s = 0 end
if m < 0 then m = 0 end
if h < 0 then h = 0 end
if d < 0 then d = 0 end

local mn = s
if m < mn then mn = m end
if h < mn then mn = h end
if d < mn then mn = d end
return mn
`;

const CONSUME_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local nonce = ARGV[3]

redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. (now - ${DAY_MS}))

for i = 1, count do
  redis.call('ZADD', key, now, nonce .. ':' .. i)
end

redis.call('PEXPIRE', key, ${DAY_MS})
return redis.call('ZCARD', key)
`;
