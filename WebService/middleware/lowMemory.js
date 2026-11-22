const { lowMemoryMode, lowMemoryText } = require('@config/lowMemory');

const requireStatisticsEnabled = (req, res, next) => {
    if (!lowMemoryMode) return next();

    res.header('Cache-Control', 'no-store');
    return res.status(503).json({
        code: 'LOW_MEMORY_MODE',
        message: lowMemoryText,
    });
};

module.exports = { requireStatisticsEnabled };
