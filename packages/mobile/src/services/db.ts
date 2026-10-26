// 本地持久化（expo-sqlite）。
//
// schema 设计取舍：
//  * `assistants` 用显式列：它需要按“最后连接时间”排序、按在线状态过滤；
//  * `messages` / `transfers` 用“索引列 + payload JSON”：这两张表的读法永远是
//    “按助理取整段历史”，显式展开十几个字段只会让 schema 与 reducer 的类型漂移；
//  * `outbox` 每个助理一行：未确认消息必须能跨进程重启恢复，否则断网重发就没了；
//  * `settings` 是简单 KV（唤醒代理、电源默认延时等本地偏好）。
//
// 迁移用 `PRAGMA user_version`，每一步都是幂等的 IF NOT EXISTS。

import * as SQLite from 'expo-sqlite'

import type { AssistantRecord } from '../core/pairing.mts'
import type { ChatMessage, Transfer } from '../core/reducer.mts'
import { createOutbox, deserializeOutbox, serializeOutbox, type Outbox } from '../core/outbox.mts'

const DB_NAME = 'openwhale.db'
const SCHEMA_VERSION = 2

export type Database = SQLite.SQLiteDatabase

let databasePromise: Promise<Database> | undefined

/** 打开（并只迁移一次）数据库。 */
export function database(): Promise<Database> {
  if (!databasePromise) {
    databasePromise = open()
  }
  return databasePromise
}

async function open(): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(DB_NAME)
  await migrate(db)
  return db
}

export async function migrate(db: Database): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;')
  await db.execAsync('PRAGMA foreign_keys = ON;')
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;')
  const version = row?.user_version ?? 0
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS assistants (
      id TEXT PRIMARY KEY NOT NULL,
      computer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      endpoints TEXT NOT NULL,
      preferred_endpoint TEXT,
      lan TEXT,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      last_connected_at TEXT,
      online INTEGER NOT NULL DEFAULT 0,
      power_allowed TEXT NOT NULL DEFAULT '["shutdown","restart","cancel"]',
      server_version TEXT,
      wake_proxy_url TEXT,
      wake_mac TEXT,
      connection_mode TEXT,
      session_id TEXT,
      session_epoch INTEGER,
      session_cursor INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      assistant_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_assistant ON messages (assistant_id, at);
    CREATE TABLE IF NOT EXISTS transfers (
      file_id TEXT PRIMARY KEY NOT NULL,
      assistant_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_assistant ON transfers (assistant_id, updated_at);
    CREATE TABLE IF NOT EXISTS outbox (
      assistant_id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
  `)
  // 老库升级：v1 → v2 补齐多端同步需要的列。每一步都用 try/catch 兜住
  // “列已存在”，保证重复执行与中断续跑都安全。
  if (version < 2) {
    for (const statement of [
      'ALTER TABLE assistants ADD COLUMN connection_mode TEXT;',
      'ALTER TABLE assistants ADD COLUMN session_id TEXT;',
      'ALTER TABLE assistants ADD COLUMN session_epoch INTEGER;',
      'ALTER TABLE assistants ADD COLUMN session_cursor INTEGER;',
    ]) {
      try {
        await db.execAsync(statement)
      } catch {
        // 列已存在（新建库已经带列）：忽略。
      }
    }
  }
  if (version < SCHEMA_VERSION) {
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  }
}

/** 助理记录 + 唤醒设置（后者是本地扩展，不来自协议）。 */
export interface StoredAssistant extends AssistantRecord {
  wakeMac?: string
}

interface AssistantRow {
  id: string
  computer_id: string
  name: string
  fingerprint: string
  endpoints: string
  preferred_endpoint: string | null
  lan: string | null
  device_id: string
  device_name: string
  paired_at: string
  last_connected_at: string | null
  online: number
  power_allowed: string
  server_version: string | null
  wake_proxy_url: string | null
  wake_mac: string | null
  connection_mode: string | null
  session_id: string | null
  session_epoch: number | null
  session_cursor: number | null
}

export async function listAssistants(): Promise<StoredAssistant[]> {
  const db = await database()
  const rows = await db.getAllAsync<AssistantRow>(
    'SELECT * FROM assistants ORDER BY COALESCE(last_connected_at, paired_at) DESC;',
  )
  return rows.map(rowToAssistant)
}

export async function getAssistant(id: string): Promise<StoredAssistant | undefined> {
  const db = await database()
  const row = await db.getFirstAsync<AssistantRow>('SELECT * FROM assistants WHERE id = ?;', [id])
  return row ? rowToAssistant(row) : undefined
}

export async function upsertAssistant(assistant: StoredAssistant): Promise<void> {
  const db = await database()
  await db.runAsync(
    `INSERT INTO assistants (
       id, computer_id, name, fingerprint, endpoints, preferred_endpoint, lan, device_id, device_name,
       paired_at, last_connected_at, online, power_allowed, server_version, wake_proxy_url, wake_mac,
       connection_mode, session_id, session_epoch, session_cursor
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       computer_id = excluded.computer_id,
       name = excluded.name,
       fingerprint = excluded.fingerprint,
       endpoints = excluded.endpoints,
       preferred_endpoint = excluded.preferred_endpoint,
       lan = excluded.lan,
       device_id = excluded.device_id,
       device_name = excluded.device_name,
       last_connected_at = excluded.last_connected_at,
       online = excluded.online,
       power_allowed = excluded.power_allowed,
       server_version = excluded.server_version,
       wake_proxy_url = excluded.wake_proxy_url,
       wake_mac = excluded.wake_mac,
       connection_mode = excluded.connection_mode,
       session_id = excluded.session_id,
       session_epoch = excluded.session_epoch,
       session_cursor = excluded.session_cursor;`,
    [
      assistant.id,
      assistant.computerId,
      assistant.name,
      assistant.fingerprint,
      JSON.stringify(assistant.endpoints ?? []),
      assistant.preferredEndpoint ?? null,
      assistant.lan ?? null,
      assistant.deviceId,
      assistant.deviceName,
      assistant.pairedAt,
      assistant.lastConnectedAt ?? null,
      assistant.online ? 1 : 0,
      JSON.stringify(assistant.powerAllowed ?? []),
      assistant.serverVersion ?? null,
      assistant.wakeProxyUrl ?? null,
      assistant.wakeMac ?? null,
      assistant.connectionMode ?? null,
      assistant.sessionId ?? null,
      assistant.sessionEpoch ?? null,
      assistant.sessionCursor ?? 0,
    ],
  )
}

export async function renameAssistant(id: string, name: string): Promise<void> {
  const db = await database()
  await db.runAsync('UPDATE assistants SET name = ? WHERE id = ?;', [name, id])
}

export async function setAssistantOnline(id: string, online: boolean, at?: string): Promise<void> {
  const db = await database()
  if (online && at) {
    await db.runAsync('UPDATE assistants SET online = 1, last_connected_at = ? WHERE id = ?;', [at, id])
    return
  }
  await db.runAsync('UPDATE assistants SET online = ? WHERE id = ?;', [online ? 1 : 0, id])
}

export async function deleteAssistant(id: string): Promise<void> {
  const db = await database()
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM messages WHERE assistant_id = ?;', [id])
    await db.runAsync('DELETE FROM transfers WHERE assistant_id = ?;', [id])
    await db.runAsync('DELETE FROM outbox WHERE assistant_id = ?;', [id])
    await db.runAsync('DELETE FROM assistants WHERE id = ?;', [id])
  })
}

export async function loadMessages(assistantId: string, limit = 400): Promise<ChatMessage[]> {
  const db = await database()
  // 取最近 N 条（子查询按时间倒序），再按时间正序交给 reducer。
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM (
       SELECT payload, at FROM messages WHERE assistant_id = ? ORDER BY at DESC LIMIT ?
     ) ORDER BY at ASC;`,
    [assistantId, limit],
  )
  return rows.map(row => parseJson<ChatMessage>(row.payload)).filter(isPresent)
}

export async function saveMessage(assistantId: string, message: ChatMessage): Promise<void> {
  const db = await database()
  await db.runAsync(
    `INSERT INTO messages (id, assistant_id, at, payload) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET at = excluded.at, payload = excluded.payload;`,
    [message.id, assistantId, message.at, JSON.stringify(message)],
  )
}

export async function saveMessages(assistantId: string, messages: ChatMessage[]): Promise<void> {
  if (messages.length === 0) return
  const db = await database()
  await db.withTransactionAsync(async () => {
    for (const message of messages) {
      await db.runAsync(
        `INSERT INTO messages (id, assistant_id, at, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET at = excluded.at, payload = excluded.payload;`,
        [message.id, assistantId, message.at, JSON.stringify(message)],
      )
    }
  })
}

/** 本地删除一条消息（长按菜单里的“删除”；电脑端历史不受影响）。 */
export async function deleteMessage(assistantId: string, id: string): Promise<void> {
  const db = await database()
  await db.runAsync('DELETE FROM messages WHERE assistant_id = ? AND id = ?;', [assistantId, id])
}

export async function loadTransfers(assistantId: string): Promise<Transfer[]> {
  const db = await database()
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM transfers WHERE assistant_id = ? ORDER BY updated_at DESC LIMIT 200;',
    [assistantId],
  )
  return rows.map(row => parseJson<Transfer>(row.payload)).filter(isPresent)
}

export async function saveTransfer(assistantId: string, transfer: Transfer): Promise<void> {
  const db = await database()
  await db.runAsync(
    `INSERT INTO transfers (file_id, assistant_id, updated_at, payload) VALUES (?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload;`,
    [transfer.fileId, assistantId, transfer.updatedAt ?? Date.now(), JSON.stringify(transfer)],
  )
}

export async function loadOutbox(assistantId: string): Promise<Outbox> {
  const db = await database()
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM outbox WHERE assistant_id = ?;', [assistantId])
  return deserializeOutbox(row?.payload ?? null)
}

export async function saveOutbox(assistantId: string, outbox: Outbox): Promise<void> {
  const db = await database()
  await db.runAsync(
    `INSERT INTO outbox (assistant_id, payload) VALUES (?, ?)
     ON CONFLICT(assistant_id) DO UPDATE SET payload = excluded.payload;`,
    [assistantId, serializeOutbox(outbox)],
  )
}

export async function clearOutbox(assistantId: string): Promise<void> {
  const db = await database()
  await db.runAsync('DELETE FROM outbox WHERE assistant_id = ?;', [assistantId])
  await saveOutbox(assistantId, createOutbox())
}

export async function getSetting(key: string): Promise<string | undefined> {
  const db = await database()
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM settings WHERE key = ?;', [key])
  return row?.value ?? undefined
}

export async function setSetting(key: string, value: string | undefined): Promise<void> {
  const db = await database()
  if (value === undefined) {
    await db.runAsync('DELETE FROM settings WHERE key = ?;', [key])
    return
  }
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [key, value],
  )
}

export async function wipeEverything(): Promise<void> {
  const db = await database()
  await db.withTransactionAsync(async () => {
    await db.execAsync('DELETE FROM messages; DELETE FROM transfers; DELETE FROM outbox; DELETE FROM assistants; DELETE FROM settings;')
  })
}

function rowToAssistant(row: AssistantRow): StoredAssistant {
  return {
    id: row.id,
    computerId: row.computer_id,
    name: row.name,
    fingerprint: row.fingerprint,
    endpoints: parseJson<string[]>(row.endpoints) ?? [],
    preferredEndpoint: row.preferred_endpoint ?? undefined,
    lan: row.lan ?? undefined,
    deviceId: row.device_id,
    deviceName: row.device_name,
    pairedAt: row.paired_at,
    lastConnectedAt: row.last_connected_at ?? undefined,
    online: row.online === 1,
    powerAllowed: parseJson<string[]>(row.power_allowed) ?? [],
    serverVersion: row.server_version ?? undefined,
    wakeProxyUrl: row.wake_proxy_url ?? undefined,
    wakeMac: row.wake_mac ?? undefined,
    connectionMode: row.connection_mode ?? undefined,
    sessionId: row.session_id ?? undefined,
    sessionEpoch: row.session_epoch ?? undefined,
    sessionCursor: row.session_cursor ?? 0,
  }
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined && value !== null
}
