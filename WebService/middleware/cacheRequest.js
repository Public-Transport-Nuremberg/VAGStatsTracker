const { addPublicStaticResponse, getPublicStaticResponseSave, addPrivateStaticResponse, getPrivateStaticResponseSave } = require('@lib/cache');

const getRouteCacheKey = (req) => `${req.baseUrl || ''}${req.route?.path || req.path || req.url}`;

/**
 * Will only work on send and json
 * @param {Number} duration | In ms
 * @returns 
 */
const plublicStaticCache = (duration) => {
    return async (req, res, next) => {
        try {
            const routeCacheKey = getRouteCacheKey(req);
            const oldSend = res.send;
            const oldJson = res.json;

            res.send = function (data) {
                res.body = data;
                if(!res.bodyType) res.bodyType = 'string';
                return oldSend.apply(res, arguments);
            }

            res.json = function (obj) {
                res.bodyType = 'json';
                res.body = JSON.stringify(obj);
                return oldJson.call(this, obj);
            };

            const cacheResult = await getPublicStaticResponseSave(routeCacheKey, duration);
            // If we get a cache hit we will return the data
            if(cacheResult) {
                process.log.debug(`Public Static Cache Hit on ${routeCacheKey}`)
                res.status(cacheResult.statusCode);
                if(cacheResult.type === 'string') return res.send(cacheResult.data)
                if(cacheResult.type === 'json') return res.json(JSON.parse(cacheResult.data))
            };

            res.on('finish', () => {
                // Every time the request finished we will add the data to the cache
                addPublicStaticResponse(routeCacheKey, res.bodyType, res.body, res.statusCode, duration)
            });
            return next();
        } catch (error) {
            return next(error);
        }
    }
}

/**
 * Will only work on send and json
 * @param {Number} duration | In ms
 * @returns 
 */
const privateStaticCache = (duration) => {
    return async (req, res, next) => {
        try {
            const routeCacheKey = getRouteCacheKey(req);
            const oldSend = res.send;
            const oldJson = res.json;

            res.send = function (data) {
                res.body = data;
                if(!res.bodyType) res.bodyType = 'string';
                return oldSend.apply(res, arguments);
            }

            res.json = function (obj) {
                res.bodyType = 'json';
                res.body = JSON.stringify(obj);
                return oldJson.call(this, obj);
            };

            const cacheResult = await getPrivateStaticResponseSave(routeCacheKey, req.authorization, duration);
            // If we get a cache hit we will return the data
            if(cacheResult) {
                process.log.debug(`Private Static Cache Hit for ${req.user.username} on ${routeCacheKey}`)
                res.status(cacheResult.statusCode);
                if(cacheResult.type === 'string') return res.send(cacheResult.data)
                if(cacheResult.type === 'json') return res.json(JSON.parse(cacheResult.data))
            };

            res.on('finish', () => {
                // Every time the request finished we will add the data to the cache
                addPrivateStaticResponse(routeCacheKey, req.authorization, res.bodyType, res.body, res.statusCode, duration)
            });
            return next();
        } catch (error) {
            return next(error);
        }
    }
}


module.exports = {
    plublicStaticCache,
    privateStaticCache
};
