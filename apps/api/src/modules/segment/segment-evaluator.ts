import type { Prisma } from '@prisma/client';
import type { SegmentDefinition, SegmentRule } from '@sendmast/shared';

/**
 * Pure function that turns a SegmentDefinition into the inputs needed to
 * find matching contactIds:
 *   - `pgWhere`:        a Prisma.ContactWhereInput merged from every PG-side
 *                       rule. Always tenant-scoped by the caller.
 *   - `eventConstraints`: ordered list of "must come from a CH lookup". The
 *                       service runs each one against ClickHouse, then
 *                       intersects (for `has`) or excludes (for `notHas`)
 *                       the resulting contactId sets with the PG result.
 *
 * Why split: PG rules compose cleanly inside one WHERE; CH rules each need
 * their own GROUP BY query (different campaignId / lastDays window). We do
 * NOT mix them in a single SQL — the engines are different DBs.
 */

export interface EventConstraint {
  /** 'has' = INTERSECT into the set; 'notHas' = EXCLUDE from the set. */
  mode: 'has' | 'notHas';
  event: 'open' | 'click';
  campaignId?: string;
  since: Date;
}

/**
 * "Has placed a paid order" — resolved from PG shop_orders, but kept out of
 * `pgWhere` because ShopOrder.contactId has no Prisma relation to Contact;
 * the service intersects/excludes the derived contactId set like events.
 */
export interface OrderConstraint {
  mode: 'has' | 'notHas';
  /** Only orders at/after this instant count; undefined = any time. */
  since?: Date;
}

export interface CompiledSegment {
  pgWhere: Prisma.ContactWhereInput;
  eventConstraints: EventConstraint[];
  orderConstraints: OrderConstraint[];
}

/**
 * Compile a definition into PG WHERE + CH constraints. All rules are AND-
 * combined (definition.op === 'AND' is enforced by the zod schema).
 *
 * NOTE: callers must additionally OR-in `{ accountId }` themselves; the
 * compiler intentionally doesn't know the tenant so it stays a pure mapping.
 */
export function compileSegment(def: SegmentDefinition): CompiledSegment {
  const andClauses: Prisma.ContactWhereInput[] = [];
  const eventConstraints: EventConstraint[] = [];
  const orderConstraints: OrderConstraint[] = [];

  for (const rule of def.rules) {
    compileRule(rule, andClauses, eventConstraints, orderConstraints);
  }

  return {
    pgWhere: andClauses.length === 0 ? {} : { AND: andClauses },
    eventConstraints,
    orderConstraints,
  };
}

function compileRule(
  rule: SegmentRule,
  andClauses: Prisma.ContactWhereInput[],
  eventConstraints: EventConstraint[],
  orderConstraints: OrderConstraint[],
): void {
  switch (rule.type) {
    case 'attribute': {
      // field is a whitelisted enum from the schema, safe to index Contact.
      const field = rule.field;
      if (rule.op === 'eq') {
        andClauses.push({ [field]: rule.value });
      } else if (rule.op === 'neq') {
        andClauses.push({ NOT: { [field]: rule.value } });
      } else if (rule.op === 'in') {
        andClauses.push({ [field]: { in: rule.value as string[] } });
      } else {
        andClauses.push({ NOT: { [field]: { in: rule.value as string[] } } });
      }
      return;
    }
    case 'subscription': {
      andClauses.push({ subscriptionStatus: rule.value });
      return;
    }
    case 'list': {
      if (rule.op === 'memberOf') {
        andClauses.push({
          memberships: { some: { listId: { in: rule.values } } },
        });
      } else {
        andClauses.push({
          NOT: { memberships: { some: { listId: { in: rule.values } } } },
        });
      }
      return;
    }
    case 'tag': {
      // Tag here = the per-tenant Tag model (contact_tags join). Custom-tags
      // (the value-set tags used for personalisation) are a different concept
      // and intentionally NOT exposed as a segmentation dimension in v1.
      if (rule.op === 'hasAny') {
        andClauses.push({ tags: { some: { tagId: { in: rule.values } } } });
      } else if (rule.op === 'notHasAny') {
        andClauses.push({
          NOT: { tags: { some: { tagId: { in: rule.values } } } },
        });
      } else {
        // hasAll: AND together "some tagId === X" for each X
        for (const tagId of rule.values) {
          andClauses.push({ tags: { some: { tagId } } });
        }
      }
      return;
    }
    case 'createdAt': {
      if (rule.op === 'lastDays') {
        const since = new Date(Date.now() - rule.days * 86_400_000);
        andClauses.push({ createdAt: { gte: since } });
      } else {
        // between
        const range: Prisma.DateTimeFilter = {};
        if (rule.from) range.gte = new Date(rule.from);
        if (rule.to) range.lte = new Date(rule.to);
        andClauses.push({ createdAt: range });
      }
      return;
    }
    case 'event': {
      const since = new Date(Date.now() - rule.lastDays * 86_400_000);
      eventConstraints.push({
        mode: rule.op,
        event: rule.event,
        campaignId: rule.campaignId,
        since,
      });
      return;
    }
    case 'order': {
      orderConstraints.push({
        mode: rule.op,
        since: rule.lastDays
          ? new Date(Date.now() - rule.lastDays * 86_400_000)
          : undefined,
      });
      return;
    }
  }
}
