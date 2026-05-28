const Joi = require('joi');

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
}).custom((value, helpers) => {
    const providedLines = [value.Linie, value.Line, value.line]
        .filter((line) => line !== undefined && line !== null && line !== '');
    const uniqueLines = new Set(providedLines);

    if (uniqueLines.size > 1) {
        return helpers.error('any.invalid');
    }

    return providedLines.length ? { Linie: providedLines[0] } : {};
});

module.exports = {
    linequerySchema,
};
