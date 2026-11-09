// Long-term memories and full-text search over the user's stored chats (Drizzle). RLS isolates
// tenants only, so every query here also filters on the user. Search queries are an OR of the
// query's words, built from letter/digit tokens so user text can never act as tsquery syntax.
import { type ChatSearchHit, type MemoryItem, newId } from "@exa/protocol";
import { type Db, type DbTx, memories, messages, parts, SEARCH_CONFIG, sessions } from "@exa/store";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { HIT_START, HIT_STOP, highlightSnippet } from "../helpers/snippet.helper.ts";

// ---------- constants ----------
/** Query words beyond this are ignored (each one widens the OR query). */
const MAX_QUERY_TERMS = 16;
/** Longer "words" are cut (Postgres refuses lexemes over 2 KB anyway). */
const MAX_TERM_CHARS = 64;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
/**
 * The text-search config as an SQL literal. The GIN indexes were built with a constant config,
 * and Postgres only matches an index expression when the config is a constant too.
 */
const CONFIG = sql.raw(`'${SEARCH_CONFIG}'`);
/** A chat hit this many days old needs twice the text rank to tie with one from today. */
const RECENCY_DAYS = sql.raw("30");
const SECONDS_PER_DAY = sql.raw("86400");
/** Up to two ~16-word fragments centred on the hits; ShortWord=1 keeps "my", "the" at edges. */
const HEADLINE_OPTIONS = [
  `StartSel="${HIT_START}"`,
  `StopSel="${HIT_STOP}"`,
  "MaxWords=16",
  "MinWords=6",
  "ShortWord=1",
  "MaxFragments=2",
  'FragmentDelimiter=" … "',
].join(", ");
const MARKER_CHARS = HIT_START + HIT_STOP;

const MEMORY_COLUMNS = {
  id: memories.id,
  topic: memories.topic,
  content: memories.content,
  sourceSessionId: memories.sourceSessionId,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

// ---------- types ----------
/** What a memory write sets. `sourceSessionId` undefined on update keeps the current one. */
export interface MemoryFields {
  topic: string;
  content: string;
  sourceSessionId?: string | null;
}

interface MemoryRow {
  id: string;
  topic: string;
  content: string;
  sourceSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ChatHitRow {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: Date | string;
}

interface ChatSearch {
  userId: string;
  tsquery: SQL;
  limit: number;
}

// ---------- memory repo ----------
export class MemoryRepo {
  constructor(private readonly db: Db) {}

  /** Most recently updated first. */
  async list(tenantId: string, userId: string, limit: number): Promise<MemoryItem[]> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .select(MEMORY_COLUMNS)
        .from(memories)
        .where(eq(memories.userId, userId))
        .orderBy(desc(memories.updatedAt))
        .limit(limit),
    );
    return rows.map(memoryFromRow);
  }

  async get(tenantId: string, userId: string, id: string): Promise<MemoryItem | null> {
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm.select(MEMORY_COLUMNS).from(memories).where(ownMemory(userId, id)),
    );
    return row ? memoryFromRow(row) : null;
  }

  async create(tenantId: string, userId: string, fields: MemoryFields): Promise<MemoryItem> {
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .insert(memories)
        .values({
          id: newId(),
          tenantId,
          userId,
          topic: fields.topic,
          content: fields.content,
          sourceSessionId: fields.sourceSessionId ?? null,
        })
        .returning(MEMORY_COLUMNS),
    );
    return memoryFromRow(row);
  }

  /** Null when the memory doesn't exist or belongs to someone else. */
  async update(
    tenantId: string,
    userId: string,
    id: string,
    fields: MemoryFields,
  ): Promise<MemoryItem | null> {
    const source = fields.sourceSessionId;
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .update(memories)
        .set({
          topic: fields.topic,
          content: fields.content,
          updatedAt: sql`now()`,
          ...(source !== undefined ? { sourceSessionId: source } : {}),
        })
        .where(ownMemory(userId, id))
        .returning(MEMORY_COLUMNS),
    );
    return row ? memoryFromRow(row) : null;
  }

  async delete(tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm.delete(memories).where(ownMemory(userId, id)).returning({ id: memories.id }),
    );
    return rows.length > 0;
  }

  async count(tenantId: string, userId: string): Promise<number> {
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(memories)
        .where(eq(memories.userId, userId)),
    );
    return row?.n ?? 0;
  }

  /** Memories matching any of the query's words, best match first (ties: newest). */
  async search(
    tenantId: string,
    userId: string,
    query: string,
    limit: number,
  ): Promise<MemoryItem[]> {
    const tsquery = anyWordQuery(query);
    if (!tsquery) return [];
    const rank = sql`ts_rank(${memories.search}, ${tsquery})`;
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .select(MEMORY_COLUMNS)
        .from(memories)
        .where(and(eq(memories.userId, userId), sql`${memories.search} @@ ${tsquery}`))
        .orderBy(desc(rank), desc(memories.updatedAt))
        .limit(limit),
    );
    return rows.map(memoryFromRow);
  }

  /**
   * Stored chat text (user prompts and answers) matching any of the query's words, in the
   * user's own top-level, unarchived chats. Ranked by text relevance discounted by age.
   */
  async searchChats(
    tenantId: string,
    userId: string,
    query: string,
    limit: number,
  ): Promise<ChatSearchHit[]> {
    const tsquery = anyWordQuery(query);
    if (!tsquery) return [];
    const rows = await this.db.withTenant(tenantId, (q) =>
      selectChatHits(q, { userId, tsquery, limit }),
    );
    return rows.map(chatHitFromRow);
  }
}

// ---------- helpers ----------
function ownMemory(userId: string, id: string): SQL | undefined {
  return and(eq(memories.id, id), eq(memories.userId, userId));
}

/** `to_tsquery('english', 'w1 | w2 | …')`, or null when the query has no words at all. */
function anyWordQuery(query: string): SQL | null {
  const tokens = query.toLowerCase().match(WORD_PATTERN) ?? [];
  const words = [...new Set(tokens.map((t) => t.slice(0, MAX_TERM_CHARS)))];
  if (!words.length) return null;
  return sql`to_tsquery(${CONFIG}, ${words.slice(0, MAX_QUERY_TERMS).join(" | ")})`;
}

/** Headlines are built only for the best `limit` matches, not for every matching part. */
function selectChatHits(q: DbTx, s: ChatSearch): Promise<ChatHitRow[]> {
  const matches = bestMatches(q, s);
  const source = sql`translate(${matches.text}, ${MARKER_CHARS}, '')`;
  return q.orm
    .select({
      sessionId: matches.sessionId,
      sessionTitle: matches.sessionTitle,
      messageId: matches.messageId,
      role: matches.role,
      createdAt: matches.createdAt,
      snippet: sql<string>`ts_headline(${CONFIG}, ${source}, ${s.tsquery}, ${HEADLINE_OPTIONS})`,
    })
    .from(matches)
    .orderBy(desc(matches.score), desc(matches.createdAt));
}

/**
 * The user's matching text parts as a ranked subquery. The match uses exactly the expression
 * and predicate of `parts_text_search_idx`, so Postgres can use that index.
 */
function bestMatches(q: DbTx, s: ChatSearch) {
  const text = sql<string>`coalesce(${parts.data}->>'text', '')`;
  const vector = sql`to_tsvector(${CONFIG}, ${text})`;
  const ageDays = sql`extract(epoch from now() - ${messages.createdAt}) / ${SECONDS_PER_DAY}`;
  const score = sql<number>`ts_rank(${vector}, ${s.tsquery}) / (1 + ${ageDays} / ${RECENCY_DAYS})`;
  return q.orm
    .select({
      sessionId: parts.sessionId,
      sessionTitle: sessions.title,
      messageId: parts.messageId,
      role: messages.role,
      createdAt: messages.createdAt,
      text: text.as("text"),
      score: score.as("score"),
    })
    .from(parts)
    .innerJoin(messages, eq(messages.id, parts.messageId))
    .innerJoin(sessions, eq(sessions.id, parts.sessionId))
    .where(
      and(
        sql`${parts.type} = 'text'`,
        sql`${vector} @@ ${s.tsquery}`,
        sql`(${parts.data}->>'synthetic') is distinct from 'true'`,
        eq(sessions.userId, s.userId),
        isNull(sessions.archivedAt),
        isNull(sessions.parentId),
      ),
    )
    .orderBy(desc(score), desc(messages.createdAt))
    .limit(s.limit)
    .as("matches");
}

function memoryFromRow(r: MemoryRow): MemoryItem {
  return {
    id: r.id,
    topic: r.topic,
    content: r.content,
    sourceSessionId: r.sourceSessionId ?? null,
    time: { created: r.createdAt.getTime(), updated: r.updatedAt.getTime() },
  };
}

function chatHitFromRow(r: ChatHitRow): ChatSearchHit {
  return {
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle ?? null,
    messageId: r.messageId,
    role: r.role === "user" ? "user" : "assistant",
    snippet: highlightSnippet(r.snippet),
    time: new Date(r.createdAt).getTime(),
  };
}
