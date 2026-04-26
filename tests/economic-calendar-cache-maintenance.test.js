const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qm-econ-cache-'));
}

function loadEconomicCalendarService(tempDir, httpsGetMock) {
  jest.resetModules();
  if (httpsGetMock) {
    jest.doMock('https', () => ({
      get: httpsGetMock,
    }));
  } else {
    jest.dontMock('https');
  }

  const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tempDir);
  const service = require('../src/services/economicCalendarService');
  return { service, cwdSpy };
}

function createHttpsGetMock(xml) {
  return jest.fn((_url, _options, callback) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = jest.fn();

    process.nextTick(() => {
      callback(response);
      process.nextTick(() => {
        response.emit('data', Buffer.from(xml, 'latin1'));
        response.emit('end');
      });
    });

    return {
      on: jest.fn().mockReturnThis(),
      setTimeout: jest.fn(),
      destroy: jest.fn(),
    };
  });
}

describe('economic calendar cache maintenance', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    jest.dontMock('https');
  });

  test('getCacheStatus reports memory and disk cache details when the cache exists', async () => {
    const tempDir = createTempWorkspace();
    const filePath = path.join(tempDir, 'data', 'economic-calendar.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const { service, cwdSpy } = loadEconomicCalendarService(tempDir);
    const events = [
      {
        title: 'US CPI',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T12:30:00.000Z',
      },
    ];
    const fetchedAt = new Date('2026-04-21T12:00:00.000Z');
    service._setCacheForTests(events, fetchedAt);
    fs.writeFileSync(filePath, JSON.stringify({ events, fetchedAt: fetchedAt.toISOString() }, null, 2), 'utf8');

    const stats = fs.statSync(filePath);
    const status = await service.getCacheStatus();

    expect(status).toEqual(expect.objectContaining({
      key: 'economic-calendar',
      label: 'Economic Calendar',
      memory: expect.objectContaining({
        exists: true,
        entryCount: 1,
        fetchedAt: fetchedAt.toISOString(),
      }),
      disk: expect.objectContaining({
        exists: true,
        path: 'data/economic-calendar.json',
        sizeBytes: stats.size,
      }),
    }));
    expect(status.totalSizeBytes).toBe(status.memory.sizeBytes + stats.size);

    cwdSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('clearCache removes the disk file and clears the in-memory cache', async () => {
    const tempDir = createTempWorkspace();
    const filePath = path.join(tempDir, 'data', 'economic-calendar.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const { service, cwdSpy } = loadEconomicCalendarService(tempDir);
    const events = [
      {
        title: 'Fed Minutes',
        currency: 'USD',
        impact: 'Medium',
        time: '2026-04-22T18:00:00.000Z',
      },
    ];
    service._setCacheForTests(events, new Date('2026-04-22T16:00:00.000Z'));
    fs.writeFileSync(filePath, JSON.stringify({ events, fetchedAt: '2026-04-22T16:00:00.000Z' }, null, 2), 'utf8');

    const status = await service.clearCache();

    expect(fs.existsSync(filePath)).toBe(false);
    expect(status).toEqual(expect.objectContaining({
      totalSizeBytes: 0,
      memory: expect.objectContaining({
        exists: false,
        entryCount: 0,
        sizeBytes: 0,
        fetchedAt: null,
      }),
      disk: expect.objectContaining({
        exists: false,
        sizeBytes: 0,
        updatedAt: null,
      }),
    }));

    cwdSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('ensureCalendar can fetch and rebuild the cache after it has been cleared', async () => {
    const tempDir = createTempWorkspace();
    const xml = `<?xml version="1.0" encoding="windows-1252"?>
      <weeklyevents>
        <event>
          <title>US CPI</title>
          <country>USD</country>
          <date><![CDATA[04-21-2026]]></date>
          <time><![CDATA[8:30am]]></time>
          <impact><![CDATA[High]]></impact>
        </event>
      </weeklyevents>`;
    const httpsGetMock = createHttpsGetMock(xml);
    const { service, cwdSpy } = loadEconomicCalendarService(tempDir, httpsGetMock);

    await service.clearCache();
    const events = await service.ensureCalendar();
    const status = await service.getCacheStatus();
    const filePath = path.join(tempDir, 'data', 'economic-calendar.json');

    expect(httpsGetMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        title: 'US CPI',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T12:30:00.000Z',
      }),
    ]);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(status.memory.exists).toBe(true);
    expect(status.disk.exists).toBe(true);
    expect(status.totalSizeBytes).toBeGreaterThan(0);

    cwdSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
