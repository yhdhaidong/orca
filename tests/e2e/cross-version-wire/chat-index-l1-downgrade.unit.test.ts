// Scratch (not committed): older builds' own record loading over a store this build installed.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  closeTestAgentSessionDatabase,
  openTestAgentSessionRecordStore
} from '../../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  storedTestAgentSessionRecord,
  withTestAgentSessionDatabase
} from '../../../src/main/runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

const idle = agentSessionRecordFixture(
  agentSessionLeaseFixture({ sessionId: 'idle', claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null })
)
const live = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'live' }))

type Rows = { records: Map<string, { lease: { unreconciled: boolean } }> }
const flags = (rows: unknown) =>
  Object.fromEntries([...(rows as Rows).records].map(([id, r]) => [id, r.lease.unreconciled]))
const savedFlags = (db: { prepare: (s: string) => { all: () => Record<string, unknown>[] } }) =>
  Object.fromEntries(
    db
      .prepare('SELECT session_id, record_json FROM agent_session_records')
      .all()
      .map((row) => [row.session_id, JSON.parse(String(row.record_json)).lease.unreconciled])
  )

for (const ref of ['v1.4.259', 'v1.4.260', 'v1.4.261']) {
  test(`${ref} treats every lease as unreconciled after this build installed the store`, { timeout: 600_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-l1-downgrade-'))
    try {
      // Create the store as this build would, then seed saved rows and reopen it (a restart).
      await openTestAgentSessionRecordStore(directory)
      await closeTestAgentSessionDatabase(directory)
      await withTestAgentSessionDatabase(directory, (db) => {
        const insert = db.prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
        insert.run('idle', JSON.stringify(storedTestAgentSessionRecord(idle)))
        insert.run('live', JSON.stringify(storedTestAgentSessionRecord(live)))
      })
      // This build: only the lease that may be held is marked.
      const current = await openTestAgentSessionRecordStore(directory)
      expect(current.getRecord('idle')?.lease.unreconciled).toBe(false)
      expect(current.getRecord('live')?.lease.unreconciled).toBe(true)
      await closeTestAgentSessionDatabase(directory)
      const checkout = await materializeReleaseCheckout(ref)
      const rows = await importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session/records/agent-session-record-rows.ts')
      const open = (rows.installAgentSessionStoreRows ?? rows.loadAgentSessionStoreRows) as (db: unknown) => unknown
      await withTestAgentSessionDatabase(directory, (db) => {
        expect(savedFlags(db)).toEqual({ idle: false, live: true })
        const loaded = flags(open(db))
        console.log(`L1-DOWNGRADE ${ref} uses ${rows.installAgentSessionStoreRows ? 'install' : 'load'}: in-memory ${JSON.stringify(loaded)} saved ${JSON.stringify(savedFlags(db))}`)
        // The older build grants no writer to either chat until its own restart reconciliation.
        expect(loaded).toEqual({ idle: true, live: true })
      })
      // Back on this build after the older one left every lease marked (e.g. it quit before reconciling).
      const reopened = await openTestAgentSessionRecordStore(directory)
      expect(reopened.getRecord('idle')?.lease.unreconciled).toBe(rows.installAgentSessionStoreRows ? true : false)
      await reopened.reconcileOnRestart({
        probe: async () => ({ outcome: 'pid-absent' }),
        now: 90_000
      })
      expect(reopened.listRecords().map((r) => [r.sessionId, r.lease.unreconciled])).toEqual([
        ['idle', false],
        ['live', false]
      ])
      await closeTestAgentSessionDatabase(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
