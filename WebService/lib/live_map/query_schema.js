const Joi = require('joi');

const wgs84PositionSchema = Joi.any().custom((value, helpers) => {
    const parts = Array.isArray(value) ? value : String(value).split(',');

    if (parts.length !== 2) return helpers.error('any.invalid');

    const longitude = Number(parts[0]);
    const latitude = Number(parts[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return helpers.error('any.invalid');
    }
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        return helpers.error('any.invalid');
    }

    return [longitude, latitude];
});

const lineValueSchema = Joi.string().trim().custom((value, helpers) => {
    const parts = value.split(',');
    for (const part of parts) {
        if (!/^[A-Z0-9]+$/i.test(part)) {
            return helpers.error('any.invalid');
        }
    }
    return value;
});

const linequerySchema = Joi.object({
    Linie: lineValueSchema,
    Line: lineValueSchema,
    line: lineValueSchema,
    pos1: wgs84PositionSchema,
    pos2: wgs84PositionSchema,
}).custom((value, helpers) => {
    const providedLines = [value.Linie, value.Line, value.line]
        .filter((line) => line !== undefined && line !== null && line !== '');
    const uniqueLines = new Set(providedLines);

    if (uniqueLines.size > 1) {
        return helpers.error('any.invalid');
    }

    if ((value.pos1 && !value.pos2) || (!value.pos1 && value.pos2)) {
        return helpers.error('any.invalid');
    }

    const normalized = providedLines.length ? { Linie: providedLines[0] } : {};
    if (value.pos1 && value.pos2) {
        const [longitude1, latitude1] = value.pos1;
        const [longitude2, latitude2] = value.pos2;

        if (longitude1 === longitude2 || latitude1 === latitude2) {
            return helpers.error('any.invalid');
        }

        normalized.boundingBox = {
            minLongitude: Math.min(longitude1, longitude2),
            maxLongitude: Math.max(longitude1, longitude2),
            minLatitude: Math.min(latitude1, latitude2),
            maxLatitude: Math.max(latitude1, latitude2),
        };
    }

    return normalized;
});

module.exports = {
    linequerySchema,
};
