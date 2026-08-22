const express = require('ultimate-express');
const { expressCspHeader, INLINE, SELF } = require('express-csp-header');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const useragent = require('express-useragent');
const errorHandler = require('@middleware/errorhandler');
const {
    getLiveMapPayload,
    linequerySchema,
    startLiveMapPositionWorker,
} = require('@lib/live_map');

const app = express();
app.set('catch async errors', true);
startLiveMapPositionWorker();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(useragent.express());
app.use((req, res, next) => {
    // Compatibility for the observation endpoint's async body-reader helper.
    req.json = async () => req.body;
    next();
});

app.use(expressCspHeader({
    directives: {
        'default-src': [SELF],
        'script-src': [SELF, INLINE],
        'style-src': [SELF, INLINE],
        'font-src': [SELF],
        'img-src': [
            SELF,
            INLINE,
            'https://tile.openstreetmap.org/',
        ],
        'worker-src': [SELF, INLINE, 'blob:'],
        'connect-src': [
            SELF,
            'ws:',
            'wss:',
            `ws://${process.env.WebSocketURL}`,
            `wss://${process.env.WebSocketURL}`,
        ],
        'block-all-mixed-content': true,
    },
}));

const parseWebSocketQuery = (rawQuery) => {
    const query = {};
    for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;
    return query;
};

// Ultimate Express exposes the native uWebSockets application for WebSockets.
app.uwsApp.ws('/api/v1/live/map/ws', {
    idleTimeout: 60,
    maxPayloadLength: 1024,
    upgrade: (response, request, context) => {
        const validation = linequerySchema.validate(parseWebSocketQuery(request.getQuery()));
        if (validation.error) {
            response.writeStatus('400 Bad Request').end(validation.error.message);
            return;
        }

        response.upgrade(
            { query: validation.value, interval: null, closed: false, sending: false },
            request.getHeader('sec-websocket-key'),
            request.getHeader('sec-websocket-protocol'),
            request.getHeader('sec-websocket-extensions'),
            context
        );
    },
    open: (ws) => {
        const state = ws.getUserData();

        const sendSnapshot = async () => {
            if (state.closed || state.sending) return;
            state.sending = true;
            try {
                const data = await getLiveMapPayload(state.query, { validated: true });
                if (!state.closed) {
                    ws.send(JSON.stringify({ type: 'snapshot', data, timestamp: new Date().toISOString() }));
                }
            } catch (error) {
                process.log.error(error);
                if (!state.closed) {
                    ws.send(JSON.stringify({ type: 'error', message: error.message || 'Failed to load live map data' }));
                }
            } finally {
                state.sending = false;
            }
        };

        state.sendSnapshot = sendSnapshot;
        state.interval = setInterval(sendSnapshot, Number(process.env.LIVE_MAP_WS_INTERVAL_MS) || 1000);
        void sendSnapshot();
    },
    message: async (ws, rawMessage) => {
        const state = ws.getUserData();
        try {
            const payload = JSON.parse(Buffer.from(rawMessage).toString('utf8'));
            if (payload.type !== 'subscribe') return;

            state.query = await linequerySchema.validateAsync({
                Linie: payload.Linie,
                Line: payload.Line,
                line: payload.line,
                pos1: payload.pos1,
                pos2: payload.pos2,
            });
            await state.sendSnapshot();
        } catch (error) {
            if (!state.closed) {
                ws.send(JSON.stringify({ type: 'error', message: error.message || 'Invalid websocket message' }));
            }
        }
    },
    close: (ws) => {
        const state = ws.getUserData();
        state.closed = true;
        clearInterval(state.interval);
    },
});

const sendHtml = (res, filename) => {
    res.header('Content-Type', 'text/html');
    res.send(fs.readFileSync(path.join(__dirname, '..', 'public', filename)));
};

app.get('/', (req, res) => sendHtml(res, 'index.html'));
app.get('/livemap', (req, res) => sendHtml(res, 'livemap.html'));
app.get('/livemap-test', (req, res) => sendHtml(res, 'livemap-test.html'));
app.get('/heatmap', (req, res) => sendHtml(res, 'heatmap.html'));
app.get('/histogram', (req, res) => sendHtml(res, 'histogram.html'));
app.get('/linestats', (req, res) => sendHtml(res, 'linestats.html'));
app.get('/departures', (req, res) => sendHtml(res, 'departures.html'));
app.get('/vehicleHistory/*', (req, res) => sendHtml(res, 'vehicleHistory.html'));
app.get('/ontimelinechart', (req, res) => sendHtml(res, 'ontimelinechart.html'));
app.get('/api-logs', (req, res) => sendHtml(res, 'api-logs.html'));
app.get('/departure-discovery', (req, res) => sendHtml(res, 'departure-discovery.html'));

app.get('/legal/legal', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'legal', 'legal.html'));
});

const apiv1 = require('@api');
app.use('/api/v1', apiv1);

const sendNotFoundResponse = (req, res, next) => {
    res.status(404);
    ejs.renderFile(path.join(__dirname, '..', 'views', 'error', 'error-xxx.ejs'), {
        statusCode: 404,
        message: 'Page not found',
        info: 'Request can not be served',
        reason: 'The requested page was not found',
        back_url: process.env.DOMAIN,
        domain: process.env.DOMAIN,
    }, (error, html) => {
        if (error) return next(error);
        res.header('Content-Type', 'text/html');
        return res.send(html);
    });
};

app.get('/*', (req, res, next) => {
    const requestedPath = decodeURIComponent(req.path);
    const publicDirectory = path.resolve(__dirname, '..', 'public');
    const resolvedPath = path.resolve(publicDirectory, `.${requestedPath}`);

    if (!resolvedPath.startsWith(`${publicDirectory}${path.sep}`) && resolvedPath !== publicDirectory) {
        return sendNotFoundResponse(req, res, next);
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    const contentTypes = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.jpeg': 'image/jpg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.html': 'text/html',
        '.json': 'application/json',
    };

    try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            return sendNotFoundResponse(req, res, next);
        }
        res.header('Content-Type', contentTypes[extension] || 'application/octet-stream');
        res.header('Cache-Control', 'public, max-age=172800');
        return res.send(fs.readFileSync(resolvedPath));
    } catch (error) {
        return next(error);
    }
});

app.use(errorHandler);

module.exports = app;
