function unwrapDateValue(value) {
  if (value && typeof value === 'object' && value.$$date != null) {
    return value.$$date;
  }
  return value;
}

function normalizeDateValue(value) {
  const unwrapped = unwrapDateValue(value);
  if (!unwrapped) return null;
  const date = unwrapped instanceof Date ? new Date(unwrapped.getTime()) : new Date(unwrapped);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateStart(value) {
  const date = normalizeDateValue(value);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function normalizeDateEnd(value) {
  const date = normalizeDateValue(value);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

function diffMinutes(left, right) {
  const leftDate = normalizeDateValue(left);
  const rightDate = normalizeDateValue(right);
  if (!leftDate || !rightDate) return null;
  return Math.round((leftDate.getTime() - rightDate.getTime()) / 60000);
}

module.exports = {
  normalizeDateValue,
  normalizeDateStart,
  normalizeDateEnd,
  diffMinutes,
};
