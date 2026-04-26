const {
  _parseCalendarXml,
  _setCacheForTests,
  _clearCacheForTests,
  isInBlackout,
} = require('../src/services/economicCalendarService');

describe('economic calendar service', () => {
  afterEach(() => {
    _clearCacheForTests();
  });

  test('parses Forex Factory XML and converts New York event times to UTC across DST changes', () => {
    const xml = `<?xml version="1.0" encoding="windows-1252"?>
      <weeklyevents>
        <event>
          <title>US Jobs Report</title>
          <country>USD</country>
          <date><![CDATA[03-06-2026]]></date>
          <time><![CDATA[8:30am]]></time>
          <impact><![CDATA[High]]></impact>
        </event>
        <event>
          <title>US CPI</title>
          <country>USD</country>
          <date><![CDATA[03-09-2026]]></date>
          <time><![CDATA[8:30am]]></time>
          <impact><![CDATA[Medium]]></impact>
        </event>
        <event>
          <title>ECB Presser</title>
          <country>EUR</country>
          <date><![CDATA[11-02-2026]]></date>
          <time><![CDATA[8:30am]]></time>
          <impact><![CDATA[Low]]></impact>
        </event>
      </weeklyevents>`;

    const events = _parseCalendarXml(xml);

    expect(events).toHaveLength(3);
    expect(events).toEqual([
      expect.objectContaining({
        title: 'US Jobs Report',
        currency: 'USD',
        impact: 'High',
        time: '2026-03-06T13:30:00.000Z',
      }),
      expect.objectContaining({
        title: 'US CPI',
        currency: 'USD',
        impact: 'Medium',
        time: '2026-03-09T12:30:00.000Z',
      }),
      expect.objectContaining({
        title: 'ECB Presser',
        currency: 'EUR',
        impact: 'Low',
        time: '2026-11-02T13:30:00.000Z',
      }),
    ]);
  });

  test('blocks inside the configured blackout window and returns the matching event', () => {
    const event = {
      title: 'US CPI',
      country: 'USD',
      currency: 'USD',
      impact: 'High',
      time: '2026-04-21T12:30:00.000Z',
    };
    _setCacheForTests([event]);

    const result = isInBlackout('EURUSD', new Date('2026-04-21T12:20:00.000Z'), {
      enabled: true,
      beforeMinutes: 15,
      afterMinutes: 15,
      impactLevels: ['High'],
    });

    expect(result).toEqual({
      blocked: true,
      event,
    });
  });

  test('does not block 16 minutes before the event window opens', () => {
    _setCacheForTests([
      {
        title: 'US CPI',
        country: 'USD',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T12:30:00.000Z',
      },
    ]);

    expect(isInBlackout('EURUSD', new Date('2026-04-21T12:14:00.000Z'), {
      enabled: true,
      beforeMinutes: 15,
      afterMinutes: 15,
      impactLevels: ['High'],
    })).toEqual({ blocked: false });
  });

  test('does not block 16 minutes after the event window closes', () => {
    _setCacheForTests([
      {
        title: 'US CPI',
        country: 'USD',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T12:30:00.000Z',
      },
    ]);

    expect(isInBlackout('EURUSD', new Date('2026-04-21T12:46:00.000Z'), {
      enabled: true,
      beforeMinutes: 15,
      afterMinutes: 15,
      impactLevels: ['High'],
    })).toEqual({ blocked: false });
  });

  test('ignores lower-impact events when the config only allows High', () => {
    _setCacheForTests([
      {
        title: 'US Housing Data',
        country: 'USD',
        currency: 'USD',
        impact: 'Medium',
        time: '2026-04-21T12:30:00.000Z',
      },
    ]);

    expect(isInBlackout('EURUSD', new Date('2026-04-21T12:30:00.000Z'), {
      enabled: true,
      beforeMinutes: 15,
      afterMinutes: 15,
      impactLevels: ['High'],
    })).toEqual({ blocked: false });
  });

  test('does not block when the event currency does not affect the symbol', () => {
    _setCacheForTests([
      {
        title: 'German PMI',
        country: 'EUR',
        currency: 'EUR',
        impact: 'High',
        time: '2026-04-21T09:00:00.000Z',
      },
    ]);

    expect(isInBlackout('USDJPY', new Date('2026-04-21T09:00:00.000Z'), {
      enabled: true,
      beforeMinutes: 15,
      afterMinutes: 15,
      impactLevels: ['High'],
    })).toEqual({ blocked: false });
  });

  test('blocks USD-quoted crypto symbols when USD news blackout is active', () => {
    _setCacheForTests([
      {
        title: 'Fed Rate Decision',
        country: 'USD',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T18:00:00.000Z',
      },
    ]);

    expect(isInBlackout('BTCUSD', new Date('2026-04-21T18:00:00.000Z'), {
      enabled: true,
      beforeMinutes: 15,
      afterMinutes: 15,
      impactLevels: ['High'],
    })).toEqual({
      blocked: true,
      event: {
        title: 'Fed Rate Decision',
        country: 'USD',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T18:00:00.000Z',
      },
    });
  });
});
