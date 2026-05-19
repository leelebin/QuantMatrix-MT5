const express = require('express');
const bootProfiler = require('../utils/bootProfiler');

const router = express.Router();

router.get('/boot-profile', (req, res) => {
  const bootTimeline = bootProfiler.getBootTimeline();

  res.json({
    success: true,
    uptime: process.uptime(),
    bootTimeline,
    slowSteps: bootProfiler.getSlowBootSteps(1000)
  });
});

module.exports = router;
