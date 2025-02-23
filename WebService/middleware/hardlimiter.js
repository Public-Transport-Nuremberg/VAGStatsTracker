const { TooManyRequests } = require('@lib/errors')

const hardlimiter = (maxParallel, maxQueue) => {
    const routeState = new Map();

    function getOrCreateRouteState(path) {
        if (!routeState.has(path)) {
            routeState.set(path, {
                activeRequests: new Set(),
                requestQueue: [],
                durations: [],          // Store last N request durations
                maxDurations: 100,      // Keep last 100 durations for average
                totalDuration: 0,       // Running total for average calculation
                avgDuration: 0          // Current average duration
            });
            process.log.debug(`[hardlimit] Created new state for route: ${path}`);
        }
        return routeState.get(path);
    }

    function updateDuration(state, duration) {
        state.durations.push(duration);
        state.totalDuration += duration;

        if (state.durations.length > state.maxDurations) {
            const removed = state.durations.shift();
            state.totalDuration -= removed;
        }

        state.avgDuration = state.totalDuration / state.durations.length;
        process.log.debug(`[hardlimit] Updated average duration: ${state.avgDuration}ms`);
    }

    function calculateRetryAfter(state) {
        const queuePosition = state.requestQueue.length;
        const activeRequests = state.activeRequests.size;
        const avgDuration = state.avgDuration || 1000; // Default to 1s if no data

        // Estimate how many "cycles" of requests until this one would be processed
        const cycles = Math.ceil((queuePosition + activeRequests + 1) / maxParallel);

        // Calculate total wait time in milliseconds
        const waitTime = Math.ceil(cycles * avgDuration);

        return Math.ceil(waitTime / 1000); // Convert to seconds
    }

    function processNextRequest(path) {
        const state = routeState.get(path);
        if (state.requestQueue.length > 0 && state.activeRequests.size < maxParallel) {
            const { resolve, id } = state.requestQueue.shift();
            state.activeRequests.add(id);
            process.log.debug(`[hardlimit] Dequeued request ${id} for ${path}. Queue length: ${state.requestQueue.length}, Active: ${state.activeRequests.size}`);
            resolve();
        }
    }

    return async (req, res, next) => {
        try {
            const path = req.route.path;
            const state = getOrCreateRouteState(path);
            const requestId = Math.random().toString(36).substring(7);
            const startTime = Date.now();

            process.log.debug(`[hardlimit] New request ${requestId} for ${path}. Queue length: ${state.requestQueue.length}, Active: ${state.activeRequests.size}`);

            // Check queue limit first before attempting to process
            if (state.requestQueue.length >= maxQueue && state.activeRequests.size >= maxParallel) {
                process.log.debug(`[hardlimit] Queue full for ${path}. Rejecting request ${requestId}`);
                const retryAfter = calculateRetryAfter(state);
                throw new TooManyRequests('Too Many Requests', retryAfter);
            }

            if (state.activeRequests.size < maxParallel) {
                state.activeRequests.add(requestId);
                process.log.debug(`[hardlimit] Processing request ${requestId} immediately. Active: ${state.activeRequests.size}`);

                res.on('finish', () => {
                    const duration = Date.now() - startTime;
                    updateDuration(state, duration);
                    state.activeRequests.delete(requestId);
                    process.log.debug(`[hardlimit] Request ${requestId} completed in ${duration}ms. Active: ${state.activeRequests.size}`);
                    processNextRequest(path);
                });
                
                next();
                return;
            }

            process.log.debug(`[hardlimit] Queueing request ${requestId}. Queue length: ${state.requestQueue.length + 1}`);
            await new Promise((resolve, reject) => {
                state.requestQueue.push({
                    resolve,
                    id: requestId
                });
            });

            res.on('finish', () => {
                const duration = Date.now() - startTime;
                updateDuration(state, duration);
                state.activeRequests.delete(requestId);
                process.log.debug(`[hardlimit] Request ${requestId} completed in ${duration}ms. Active: ${state.activeRequests.size}`);
                processNextRequest(path);
            });

            next();

        } catch (error) {
            next(error);
        }
    };
};

module.exports = {
    hardlimiter
};