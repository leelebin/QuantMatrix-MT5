describe('boot profiler', () => {
  const loadProfiler = () => {
    jest.resetModules();
    process.env.BOOT_PROFILER = 'true';
    return require('../src/utils/bootProfiler');
  };

  afterEach(() => {
    delete process.env.BOOT_PROFILER;
    jest.restoreAllMocks();
  });

  test('mark works', () => {
    const profiler = loadProfiler();
    const entry = profiler.mark('boot:test-mark');

    expect(entry).toMatchObject({
      label: 'boot:test-mark',
      type: 'mark',
      durationMs: 0
    });
    expect(profiler.getBootTimeline()).toHaveLength(1);
  });

  test('measure works', () => {
    const profiler = loadProfiler();
    const result = profiler.measure('boot:test-measure', () => 42);
    const [entry] = profiler.getBootTimeline();

    expect(result).toBe(42);
    expect(entry.label).toBe('boot:test-measure');
    expect(entry.type).toBe('measure');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('measureAsync works', async () => {
    const profiler = loadProfiler();
    const result = await profiler.measureAsync('boot:test-async', async () => 'done');
    const [entry] = profiler.getBootTimeline();

    expect(result).toBe('done');
    expect(entry.label).toBe('boot:test-async');
    expect(entry.type).toBe('measure');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('disabled env works', () => {
    jest.resetModules();
    process.env.BOOT_PROFILER = 'false';
    const profiler = require('../src/utils/bootProfiler');

    const entry = profiler.mark('boot:disabled');

    expect(entry).toBeNull();
    expect(profiler.getBootTimeline()).toEqual([]);
  });

  test('boot timeline structure correct', () => {
    const profiler = loadProfiler();
    profiler.measure('boot:structure', () => {});
    const [entry] = profiler.getBootTimeline();

    expect(entry).toEqual(expect.objectContaining({
      label: 'boot:structure',
      type: 'measure',
      startedAtMs: expect.any(Number),
      endedAtMs: expect.any(Number),
      durationMs: expect.any(Number),
      timestamp: expect.any(String)
    }));
    expect(entry.endedAtMs).toBeGreaterThanOrEqual(entry.startedAtMs);
  });

  test('slowSteps filter works', () => {
    const profiler = loadProfiler();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1005)
      .mockReturnValueOnce(1005)
      .mockReturnValueOnce(2510);

    profiler.measure('boot:fast', () => {});
    profiler.measure('boot:slow', () => {});

    expect(profiler.getSlowBootSteps(1000)).toEqual([
      expect.objectContaining({
        label: 'boot:slow',
        durationMs: 1505
      })
    ]);
  });
});
