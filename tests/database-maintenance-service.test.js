const EventEmitter = require('events');

function makeDb() {
  const db = new EventEmitter();
  db.count = jest.fn();
  db.remove = jest.fn();
  db.persistence = {
    compactDatafile: jest.fn(() => {
      setImmediate(() => db.emit('compactionDone'));
    }),
  };
  return db;
}

const mockBacktestsDb = makeDb();
const mockBatchBacktestJobsDb = makeDb();
const mockDecisionAuditDb = makeDb();
const mockExecutionAuditDb = makeDb();

jest.mock('../src/config/db', () => ({
  DATA_DIR: 'C:\\fake-data',
  DATABASES: {
    backtests: { filename: 'backtests.db', db: mockBacktestsDb },
    batchBacktestJobs: { filename: 'batch_backtest_jobs.db', db: mockBatchBacktestJobsDb },
    decisionAudit: { filename: 'decision_audit.db', db: mockDecisionAuditDb },
    executionAudit: { filename: 'execution_audit.db', db: mockExecutionAuditDb },
  },
}));

const databaseMaintenanceService = require('../src/services/databaseMaintenanceService');

describe('database maintenance service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBacktestsDb.count.mockResolvedValue(2);
    mockBacktestsDb.remove.mockResolvedValue(2);
    mockBatchBacktestJobsDb.count.mockResolvedValue(1);
    mockBatchBacktestJobsDb.remove.mockResolvedValue(1);
    mockDecisionAuditDb.count.mockResolvedValue(3);
    mockDecisionAuditDb.remove.mockResolvedValue(3);
    mockExecutionAuditDb.count.mockResolvedValue(4);
    mockExecutionAuditDb.remove.mockResolvedValue(4);
  });

  test('cleanupOldRecords previews supported targets without deleting', async () => {
    const now = new Date('2026-04-29T00:00:00.000Z');

    const result = await databaseMaintenanceService.cleanupOldRecords({
      dryRun: true,
      now,
      retentionDays: 10,
    });

    expect(result.dryRun).toBe(true);
    expect(result.totalMatched).toBe(10);
    expect(result.totalRemoved).toBe(0);
    expect(mockBacktestsDb.remove).not.toHaveBeenCalled();
    expect(mockBatchBacktestJobsDb.remove).not.toHaveBeenCalled();
    expect(mockDecisionAuditDb.remove).not.toHaveBeenCalled();
    expect(mockExecutionAuditDb.remove).not.toHaveBeenCalled();
    expect(mockBacktestsDb.count).toHaveBeenCalledWith({
      createdAt: { $lt: new Date('2026-04-19T00:00:00.000Z') },
    });
    expect(mockBatchBacktestJobsDb.count).toHaveBeenCalledWith({
      createdAt: { $lt: '2026-04-19T00:00:00.000Z' },
      status: { $in: ['completed', 'error'] },
    });
  });

  test('cleanupOldRecords deletes old records when dryRun is false', async () => {
    const result = await databaseMaintenanceService.cleanupOldRecords({
      targets: ['decisionAudit'],
      dryRun: false,
      now: new Date('2026-04-29T00:00:00.000Z'),
      retentionDays: 7,
    });

    expect(result.dryRun).toBe(false);
    expect(result.totalMatched).toBe(3);
    expect(result.totalRemoved).toBe(3);
    expect(mockDecisionAuditDb.remove).toHaveBeenCalledWith(
      { createdAt: { $lt: new Date('2026-04-22T00:00:00.000Z') } },
      { multi: true }
    );
  });

  test('cleanupOldRecords rejects unknown cleanup targets', async () => {
    await expect(
      databaseMaintenanceService.cleanupOldRecords({ targets: ['logs'] })
    ).rejects.toMatchObject({
      message: 'Unknown cleanup target: logs',
      statusCode: 400,
    });
  });

  test('compactDatabases waits for the NeDB compaction event', async () => {
    const result = await databaseMaintenanceService.compactDatabases({
      targets: ['backtests'],
      timeoutMs: 5000,
    });

    expect(mockBacktestsDb.persistence.compactDatafile).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([
      expect.objectContaining({
        name: 'backtests',
        filename: 'backtests.db',
        compacted: true,
      }),
    ]);
  });
});
