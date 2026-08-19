const express = require('ultimate-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const {
    findAllTripKeys,
    getValuesFromKeys,
    getTripNumbersByLineDirectionAndNextStop,
} = require('@lib/redis');
const { getLiveMapPayload, linequerySchema } = require('@lib/live_map');
const router = new express.Router();

const lineSchema = Joi.string().trim().max(16).pattern(/^[A-Z0-9]+$/i);
const directionSchema = Joi.string().trim().max(64).pattern(/^[^:]+$/);
const stopSchema = Joi.number().integer().min(1);

const liveTripsQuerySchema = Joi.object({
    Linie: lineSchema,
    line: lineSchema,
    Richtung: directionSchema,
    direction: directionSchema,
    nextVGNKennung: stopSchema,
    nextStop: stopSchema,
}).custom((value, helpers) => {
    const line = value.Linie ?? value.line;
    const direction = value.Richtung ?? value.direction;
    const nextStop = value.nextVGNKennung ?? value.nextStop;

    if (value.Linie !== undefined && value.line !== undefined && value.Linie !== value.line) {
        return helpers.error('any.invalid');
    }
    if (value.Richtung !== undefined && value.direction !== undefined && value.Richtung !== value.direction) {
        return helpers.error('any.invalid');
    }
    if (value.nextVGNKennung !== undefined && value.nextStop !== undefined
        && value.nextVGNKennung !== value.nextStop) {
        return helpers.error('any.invalid');
    }
    if (line === undefined || direction === undefined || nextStop === undefined) {
        return helpers.error('any.required');
    }

    return { line, direction, nextStop };
});

/* Plugin info*/
const PluginName = 'Live'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('/all', limiter(), async (req, res) => {
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys("TRIP:", allTripKeys);

    res.status(200).json(allTripValues);
});

router.get('/map', limiter(), async (req, res) => {
    const query = await linequerySchema.validateAsync(req.query);
    res.status(200).json(await getLiveMapPayload(query, { validated: true }));
});

router.get('/trips', limiter(), async (req, res) => {
    const query = await liveTripsQuerySchema.validateAsync(req.query);
    const Fahrtnummern = await getTripNumbersByLineDirectionAndNextStop(
        query.line,
        query.direction,
        query.nextStop,
    );

    res.status(200).json({
        Linie: query.line,
        Richtung: query.direction,
        nextVGNKennung: query.nextStop,
        Fahrtnummern,
        count: Fahrtnummern.length,
    });
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};
