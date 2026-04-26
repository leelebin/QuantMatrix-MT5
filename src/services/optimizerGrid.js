const MAX_OPTIMIZER_COMBINATIONS = 50000;

function buildOptimizerConfigError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function buildParamSpecs(paramRanges) {
  return Object.entries(paramRanges).map(([name, range]) => {
    const min = Number(range?.min);
    const max = Number(range?.max);
    const step = Number(range?.step);

    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) {
      throw buildOptimizerConfigError(`Invalid optimizer range for ${name}: min/max/step must be numbers.`);
    }

    if (step <= 0) {
      throw buildOptimizerConfigError(`Invalid optimizer range for ${name}: step must be greater than 0.`);
    }

    if (max < min) {
      throw buildOptimizerConfigError(`Invalid optimizer range for ${name}: max must be greater than or equal to min.`);
    }

    const values = [];
    for (let index = 0; index < 10000; index++) {
      const value = parseFloat((min + (step * index)).toFixed(4));
      if (value > max + (step * 0.01)) {
        break;
      }
      values.push(value);
    }

    if (values.length === 0) {
      throw buildOptimizerConfigError(`Invalid optimizer range for ${name}: no candidate values generated.`);
    }

    if (values.length >= 10000) {
      throw buildOptimizerConfigError(`Optimizer range for ${name} generated too many values. Narrow the range or increase the step.`);
    }

    return { name, values };
  });
}

function countCombinations(paramSpecs, maxCombinations = MAX_OPTIMIZER_COMBINATIONS) {
  let total = 1;
  for (const spec of paramSpecs) {
    total *= spec.values.length;
    if (total > maxCombinations) {
      throw buildOptimizerConfigError(
        `Optimizer grid too large: ${total.toLocaleString()} combinations exceeds the limit of `
        + `${maxCombinations.toLocaleString()}. Narrow the parameter ranges.`
      );
    }
  }
  return total;
}

function* iterateCombinations(paramSpecs, index = 0, current = {}) {
  if (index >= paramSpecs.length) {
    yield { ...current };
    return;
  }

  const spec = paramSpecs[index];
  for (const value of spec.values) {
    current[spec.name] = value;
    yield* iterateCombinations(paramSpecs, index + 1, current);
  }

  delete current[spec.name];
}

function combinationAt(paramSpecs, flatIndex) {
  if (!Number.isInteger(flatIndex) || flatIndex < 0) {
    throw new Error(`Invalid optimizer combination index: ${flatIndex}`);
  }

  const combo = {};
  let remainder = flatIndex;

  for (let specIndex = paramSpecs.length - 1; specIndex >= 0; specIndex--) {
    const spec = paramSpecs[specIndex];
    const base = spec.values.length;
    const valueIndex = remainder % base;
    combo[spec.name] = spec.values[valueIndex];
    remainder = Math.floor(remainder / base);
  }

  if (remainder > 0) {
    throw new Error(`Optimizer combination index out of bounds: ${flatIndex}`);
  }

  return combo;
}

module.exports = {
  MAX_OPTIMIZER_COMBINATIONS,
  buildOptimizerConfigError,
  buildParamSpecs,
  countCombinations,
  iterateCombinations,
  combinationAt,
};
