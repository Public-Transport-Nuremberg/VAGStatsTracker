const path = require('path');
const ejs = require('ejs');
const { log_errors } = require('@config/errors');

const errorHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (process.env.SENTRY_DSN) process.sentry.captureException(error);
    process.log.debug(error);

    const outError = {
        message: error.message || '',
        info: error.info || '',
        reason: error.reason || '',
        headers: error.headers || false,
        statusCode: error.status || 500,
        back_url: error.back_url || false,
    };

    if (error.name === 'ValidationError' || error.name === 'InvalidOption') {
        outError.message = error.name;
        outError.info = error.message;
        outError.reason = error.details;
        outError.statusCode = 400;
    }
    if (error.message === 'Token not provided' || error.message === 'Token Invalid') outError.statusCode = 401;
    if (error.message === 'NoPermissions' || error.message === 'Permission Denied') outError.statusCode = 403;
    if (error.message === 'Too Many Requests' || error.message === 'Too Many Requests - IP Blocked') outError.statusCode = 429;

    if (log_errors[error.name]) {
        process.log.error(`[${outError.statusCode}] ${req.method} "${req.url}" >> ${outError.message} in "${error.path}:${error.fileline}"`);
    }

    res.status(outError.statusCode);
    if (outError.headers) res.header(outError.headers.name, outError.headers.value);

    if (outError.back_url && req.headers.accept !== 'application/json') {
        outError.domain = process.env.DOMAIN;
        return ejs.renderFile(path.join(__dirname, '..', 'views', 'error', 'error-xxx.ejs'), outError, (renderError, html) => {
            if (renderError) {
                process.log.error(renderError);
                res.header('Content-Type', 'application/json');
                return res.json({
                    message: outError.message,
                    info: outError.info,
                    reason: outError.reason,
                });
            }
            res.header('Content-Type', 'text/html');
            return res.send(html);
        });
    }

    res.header('Content-Type', 'application/json');
    return res.json({
        message: outError.message,
        info: outError.info,
        reason: outError.reason,
    });
};

module.exports = errorHandler;
