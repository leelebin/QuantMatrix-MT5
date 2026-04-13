describe('risk profile model', () => {
  let riskProfilesDb;
  let RiskProfile;

  function loadModel() {
    jest.resetModules();

    const sortMock = jest.fn().mockResolvedValue([]);
    riskProfilesDb = {
      count: jest.fn().mockResolvedValue(1),
      find: jest.fn(() => ({ sort: sortMock })),
      findOne: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    jest.doMock('../src/config/db', () => ({
      riskProfilesDb,
    }));

    RiskProfile = require('../src/models/RiskProfile');
  }

  beforeEach(() => {
    loadModel();
  });

  afterEach(() => {
    jest.dontMock('../src/config/db');
  });

  test('create applies the default breakeven configuration when none is provided', async () => {
    riskProfilesDb.findOne.mockResolvedValueOnce(null);
    riskProfilesDb.insert.mockImplementation(async (doc) => doc);

    await RiskProfile.create({
      name: 'Balanced Risk',
      maxRiskPerTradePct: 1,
      maxDailyLossPct: 2,
      maxDrawdownPct: 5,
      maxConcurrentPositions: 4,
      maxPositionsPerSymbol: 2,
      allowAggressiveMinLot: false,
    });

    expect(riskProfilesDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Balanced Risk',
      tradeManagement: {
        breakeven: expect.objectContaining({
          enabled: true,
          triggerAtrMultiple: 0.8,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1,
        }),
      },
    }));
  });

  test('update rejects breakeven configs where the trailing threshold is below the trigger threshold', async () => {
    riskProfilesDb.findOne.mockResolvedValueOnce({
      _id: 'profile-1',
      name: 'Balanced Risk',
      nameKey: 'balanced risk',
      maxRiskPerTradePct: 1,
      maxDailyLossPct: 2,
      maxDrawdownPct: 5,
      maxConcurrentPositions: 4,
      maxPositionsPerSymbol: 2,
      allowAggressiveMinLot: false,
      tradeManagement: {
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1.0,
        },
      },
    });

    await expect(RiskProfile.update('profile-1', {
      tradeManagement: {
        breakeven: {
          triggerAtrMultiple: 1.2,
          trailStartAtrMultiple: 1.1,
        },
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      details: expect.arrayContaining([
        expect.objectContaining({
          field: 'tradeManagement.breakeven.trailStartAtrMultiple',
        }),
      ]),
    });

    expect(riskProfilesDb.update).not.toHaveBeenCalled();
  });
});
