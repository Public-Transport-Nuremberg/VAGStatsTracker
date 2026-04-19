
module.exports = {
    WipeCache: redis.WipeCache,
    getMemoryUsage: redis.getMemoryUsage,
    addWebtoken: redis.addWebtoken,
    getWebtokenSave: redis.getWebtokenSave,
    delWebtoken: redis.delWebtoken,
    logoutWebtoken: redis.logoutWebtoken,
    addPublicStaticResponse: redis.addPublicStaticResponse,
    getPublicStaticResponseSave: redis.getPublicStaticResponseSave,
    addPrivateStaticResponse: redis.addPrivateStaticResponse,
    getPrivateStaticResponseSave: redis.getPrivateStaticResponseSave,
    IPLimit: redis.IPLimit,
    IPCheck: redis.IPCheck,
    LimiterMiddleware: redis.LimiterMiddleware
};